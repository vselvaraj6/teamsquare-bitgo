/**
 * tools/executor.ts
 *
 * Implements all tools exposed to GPT-4o.
 * Each function is called by the agent loop when the model requests a tool.
 *
 * Safety design:
 *   - check_address_risk runs BOTH when GPT-4o asks for it AND again inside
 *     execute_transaction. Blocked addresses can never reach BitGo sendcoins.
 *   - Any tool error returns a structured failure object — never throws — so the
 *     agent loop can pass a meaningful tool result back to the model.
 *   - Balance is parsed from either numeric or string fields to support all
 *     BitGo coin types (SOL returns *String fields, BTC returns numeric fields).
 */

import chalk from "chalk";
import { getWallet, getTransfers, sendCoins } from "../bitgo.js";
import { config } from "../config.js";
import { checkAddressOnChainAbuse } from "../riskApi.js";


// ─── Tool: get_wallet_balance ─────────────────────────────────────────────────

/**
 * Fetches live wallet balance from BitGo.
 * Handles both numeric balance fields (BTC-family) and string balance fields (SOL).
 */
export async function toolGetWalletBalance(): Promise<object> {
  try {
    const wallet = await getWallet();

    // SOL and some other coins return *String fields instead of numeric fields
    const spendable =
      wallet.spendableBalance ??
      (wallet.spendableBalanceString ? Number(wallet.spendableBalanceString) : undefined) ??
      wallet.confirmedBalance ??
      (wallet.confirmedBalanceString ? Number(wallet.confirmedBalanceString) : undefined) ??
      wallet.balance ??
      (wallet.balanceString ? Number(wallet.balanceString) : 0);

    return {
      success: true,
      walletId: wallet.id,
      coin: wallet.coin,
      label: wallet.label ?? "My Wallet",
      spendableBalance: spendable,
      balanceDisplay: `${spendable} base units (${wallet.coin})`,
    };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ─── Tool: get_recent_transactions ───────────────────────────────────────────

/**
 * Fetches recent wallet activity from BitGo.
 * Useful for finding addresses previously sent to.
 */
export async function toolGetRecentTransactions(limit: number = 10): Promise<object> {
  try {
    const data = await getTransfers(limit);
    const simplified = data.transfers.map((t: any) => {
      // BitGo transfers have multiple entries. 
      // For a "send", we want the entry that isn't our own wallet (or has the negative value).
      // For this demo, we'll just pick the most relevant address.
      const externalEntry = t.entries?.find((e: any) => e.wallet === undefined) || t.entries?.[0];
      
      return {
        txid: t.txid,
        address: externalEntry?.address || t.to || "unknown",
        type: t.type, // 'send' or 'receive'
        amount: Math.abs(t.value),
        status: t.state,
        date: t.confirmedTime,
        comment: t.comment || t.label,
      };
    });

    return {
      success: true,
      count: simplified.length,
      transactions: simplified,
    };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ─── Tool: check_address_risk ─────────────────────────────────────────────────

export interface AddressRiskResult {
  address: string;
  risk: "low" | "medium" | "high" | "critical";
  blocked: boolean;
  flags: string[];
  summary: string;
  /** ChainAbuse enrichment — present when scam reports exist */
  chainAbuse?: {
    reportCount: number;
    totalLostUsd: number;
    categories: string[];
    reports: Array<{ scamCategory: string; description: string; amountLost: number | null; createdAt: string }>;
    url: string;
  };
}

/**
 * Evaluates the risk of sending to a given address.
 *
 * Checks in order:
 *   1. Heuristic patterns → catch obviously malformed addresses (no API needed)
 *   2. ChainAbuse API     → community-reported scam cases
 *
 * Fails open: API unavailability never blocks a transaction.
 */
export async function toolCheckAddressRisk(address: string): Promise<AddressRiskResult> {
  const flags: string[] = [];

  // 1. Heuristic pattern checks — format-based, zero maintenance
  if (/^0x0{10,}/i.test(address)) flags.push("looks_like_null_address");
  if (/^0xdead/i.test(address))   flags.push("looks_like_burn_address");
  if (address.trim().length < 10) flags.push("suspiciously_short_address");
  if (/^(.)\1{9,}$/.test(address.replace(/^0x/, ""))) flags.push("all_same_characters");

  if (flags.length > 0) {
    return {
      address,
      risk: "high",
      blocked: false,
      flags,
      summary: `Address has suspicious characteristics: ${flags.join(", ")}. Proceed with caution.`,
    };
  }

  // 2. ChainAbuse API — community scam reports
  const abuse = await checkAddressOnChainAbuse(address);
  const abuseNote = buildAbuseNote(abuse);

  if (abuse.available && abuse.reportCount > 0) {
    return {
      address,
      risk: "high",
      blocked: true,
      flags: ["chainabuse:scam_reports"],
      summary: `BLOCKED — ChainAbuse: ${abuse.reportCount} scam report(s) found.${abuseNote}`,
      chainAbuse: abuse,
    } as AddressRiskResult;
  }

  if (!abuse.available) {
    return {
      address,
      risk: "medium",
      blocked: false,
      flags: ["chainabuse:unavailable"],
      summary: "ChainAbuse API unavailable or key not set. Confirm with user before sending.",
    };
  }

  return {
    address,
    risk: "low",
    blocked: false,
    flags: ["chainabuse:clean"],
    summary: "No scam reports found on ChainAbuse. Safe to proceed.",
  };
}

/** Formats a ChainAbuse result into a short sentence for the summary field. */
function buildAbuseNote(abuse: { available: boolean; reportCount: number; totalLostUsd: number; categories: string[] }): string {
  if (!abuse.available || abuse.reportCount === 0) return "";
  const lost = abuse.totalLostUsd > 0 ? ` $${abuse.totalLostUsd.toLocaleString()} reported lost.` : "";
  const cats = abuse.categories.length > 0 ? ` Categories: ${abuse.categories.join(", ")}.` : "";
  return ` ChainAbuse: ${abuse.reportCount} report(s).${lost}${cats}`;
}

// ─── Tool: execute_transaction ────────────────────────────────────────────────

/**
 * Executes a transaction via BitGo after enforcing safety checks.
 * Safety checks run here regardless of what GPT-4o already called.
 */
export async function toolExecuteTransaction(
  to: string,
  amount_satoshis: number,
  memo?: string
): Promise<object> {
  // Defense in depth: re-run address check inside the tool
  const risk = await toolCheckAddressRisk(to);
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

  // Verify sufficient balance
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

/** Routes a tool call from GPT-4o to the correct implementation. */
export async function executeTool(name: string, input: Record<string, unknown>): Promise<object> {
  switch (name) {
    case "get_wallet_balance":
      return toolGetWalletBalance();
    case "get_recent_transactions":
      return toolGetRecentTransactions(input.limit as number | undefined);
    case "check_address_risk":
      return await toolCheckAddressRisk(input.address as string);
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
