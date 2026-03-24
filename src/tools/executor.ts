/**
 * tools/executor.ts
 *
 * Implements the three tools exposed to Claude.
 * Each tool function is called by the agent loop when Claude issues a tool_use block.
 *
 * Safety design:
 *   - check_address_risk runs BOTH when Claude asks for it AND again inside
 *     execute_transaction. This means the safety check cannot be bypassed even
 *     if Claude somehow skips the explicit check step.
 *   - Any tool error returns a structured failure object — never throws — so the
 *     agent loop can pass a meaningful tool_result back to Claude.
 */

import chalk from "chalk";
import { getWallet, sendCoins } from "../bitgo.js";
import { config } from "../config.js";

// ─── Address Policy Lists ─────────────────────────────────────────────────────

/**
 * Hard-blocked addresses: sending to these is always rejected.
 * Extend this list with addresses from threat intelligence feeds.
 */
const BLOCKLIST: Record<string, string> = {
  "0x0000000000000000000000000000000000000000": "null address — funds permanently unrecoverable",
  "0xdead000000000000000042069420694206942069": "known burn address",
  "0x000000000000000000000000000000000000dead": "dead address — funds permanently unrecoverable",
  "1CounterpartyXXXXXXXXXXXXXXXUWLpVr": "Counterparty burn address",
};

/**
 * Pre-approved addresses: skip the medium-risk confirmation prompt for these.
 * In production this would be loaded from a database or policy engine.
 */
const WHITELIST = new Set([
  "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", // demo safe address (testnet)
]);

// ─── Tool: get_wallet_balance ─────────────────────────────────────────────────

/**
 * Fetches live wallet balance from BitGo.
 * Prefers spendableBalance over confirmedBalance over balance,
 * since spendableBalance accounts for pending outgoing transactions.
 */
export async function toolGetWalletBalance(): Promise<object> {
  try {
    const wallet = await getWallet();
    const spendable = wallet.spendableBalance ?? wallet.confirmedBalance ?? wallet.balance;
    return {
      success: true,
      walletId: wallet.id,
      coin: wallet.coin,
      label: wallet.label ?? "My Wallet",
      balance: wallet.balance,
      spendableBalance: spendable,
      balanceDisplay: `${spendable} base units (${wallet.coin})`,
    };
  } catch (err) {
    // Return structured failure so the agent can report it gracefully
    return { success: false, error: String(err) };
  }
}

// ─── Tool: check_address_risk ─────────────────────────────────────────────────

export interface AddressRiskResult {
  address: string;
  risk: "low" | "medium" | "high" | "critical";
  blocked: boolean;
  whitelisted: boolean;
  flags: string[];
  summary: string;
}

/**
 * Evaluates the risk of sending to a given address.
 *
 * Checks in order:
 *   1. Hard blocklist  → risk: critical, blocked: true
 *   2. Whitelist       → risk: low, blocked: false
 *   3. Heuristic flags → risk: high if flagged, medium if unknown
 *
 * Returns a structured result that Claude uses to decide whether to
 * proceed, block, or ask the user to confirm.
 */
export function toolCheckAddressRisk(address: string): AddressRiskResult {
  const flags: string[] = [];
  const normalized = address.trim().toLowerCase();

  // 1. Blocklist check (case-insensitive)
  const blockReason = BLOCKLIST[address] ?? BLOCKLIST[normalized];
  if (blockReason) {
    return {
      address,
      risk: "critical",
      blocked: true,
      whitelisted: false,
      flags: ["blocklisted", "funds_unrecoverable"],
      summary: `BLOCKED — ${blockReason}`,
    };
  }

  // 2. Whitelist check
  if (WHITELIST.has(address) || WHITELIST.has(normalized)) {
    return {
      address,
      risk: "low",
      blocked: false,
      whitelisted: true,
      flags: ["whitelisted"],
      summary: "Address is on the approved whitelist.",
    };
  }

  // 3. Heuristic pattern checks
  if (/^0x0{10,}/i.test(address)) {
    flags.push("looks_like_null_address");
  }
  if (/^0xdead/i.test(address)) {
    flags.push("looks_like_burn_address");
  }
  if (address.length < 10) {
    flags.push("suspiciously_short_address");
  }
  // Repeated characters (e.g. "aaaaaaaaaaaa") — common in vanity scam addresses
  if (/^(.)\1{9,}$/.test(address.replace(/^0x/, ""))) {
    flags.push("all_same_characters");
  }

  if (flags.length > 0) {
    return {
      address,
      risk: "high",
      blocked: false,
      whitelisted: false,
      flags,
      summary: `Address has suspicious characteristics: ${flags.join(", ")}. Proceed with caution.`,
    };
  }

  // Default: unrecognized address — not blocked, but requires user confirmation
  return {
    address,
    risk: "medium",
    blocked: false,
    whitelisted: false,
    flags: ["unrecognized_address"],
    summary:
      "Address is not on blocklist or whitelist. Not seen before — confirm with user before sending.",
  };
}

// ─── Tool: execute_transaction ────────────────────────────────────────────────

/**
 * Executes a transaction via BitGo after enforcing safety checks.
 *
 * Safety checks (run regardless of what Claude already did):
 *   - Address not in blocklist
 *   - Amount > 0
 *   - Sufficient spendable balance
 *
 * This is the final gate. Even if Claude skips check_address_risk,
 * a blocked address will never reach BitGo sendcoins.
 */
export async function toolExecuteTransaction(
  to: string,
  amount_satoshis: number,
  memo?: string
): Promise<object> {
  // Re-run address safety check inside the tool (defense in depth)
  const risk = toolCheckAddressRisk(to);
  if (risk.blocked) {
    return {
      success: false,
      blocked: true,
      reason: `Transaction blocked by safety check: ${risk.summary}`,
    };
  }

  if (amount_satoshis <= 0) {
    return { success: false, blocked: true, reason: "Amount must be greater than zero." };
  }

  // Verify sufficient balance before sending
  let walletData: { spendableBalance?: number; success: boolean };
  try {
    walletData = await toolGetWalletBalance() as { spendableBalance?: number; success: boolean };
  } catch {
    return { success: false, blocked: true, reason: "Could not verify wallet balance." };
  }

  if (!walletData.success) {
    return { success: false, blocked: true, reason: "Could not verify wallet balance." };
  }

  if (walletData.spendableBalance !== undefined && amount_satoshis > walletData.spendableBalance) {
    return {
      success: false,
      blocked: true,
      reason: `Insufficient balance. Spendable: ${walletData.spendableBalance}, Requested: ${amount_satoshis}`,
    };
  }

  // All checks passed — broadcast via BitGo
  try {
    console.log(chalk.yellow(`  → Sending ${amount_satoshis} to ${to}...`));
    const result = await sendCoins({ address: to, amount: amount_satoshis, memo });
    return {
      success: true,
      txid: result.txid,
      status: result.status,
      to,
      amount_satoshis,
      memo: memo ?? null,
      coin: config.bitgo.coin,
    };
  } catch (err) {
    return { success: false, blocked: false, error: String(err) };
  }
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

/**
 * Routes a tool_use block from Claude to the correct implementation.
 * Called by the agent loop for each tool_use content block in a response.
 */
export async function executeTool(name: string, input: Record<string, unknown>): Promise<object> {
  switch (name) {
    case "get_wallet_balance":
      return toolGetWalletBalance();

    case "check_address_risk":
      return toolCheckAddressRisk(input.address as string);

    case "execute_transaction":
      return toolExecuteTransaction(
        input.to as string,
        input.amount_satoshis as number,
        input.memo as string | undefined
      );

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
