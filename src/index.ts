/**
 * index.ts
 *
 * CLI entry point for TxGuard.
 *
 * On startup:
 *   1. Validates BitGo credentials (verifyAuth)
 *   2. Fetches live wallet info to display balance
 *   3. Opens a readline loop for multi-turn conversation
 *
 * Each user message is passed to runAgent() which handles the
 * Claude + tool loop. Conversation history is maintained across
 * turns so Claude has full context (e.g. "yes, proceed" works
 * after a clarification request).
 *
 * Usage:
 *   npm start
 *   # or
 *   npx tsx src/index.ts
 */

import readline from "readline";
import chalk from "chalk";
import { getWallet, verifyAuth } from "./bitgo.js";
import { runAgent, formatToolCall, formatToolResult, type Message } from "./agent.js";

// ─── Banner ───────────────────────────────────────────────────────────────────

/** Prints the startup banner with wallet info. */
function printBanner(coin: string, balance: number, label: string) {
  console.log("");
  console.log(chalk.bold.white("╔══════════════════════════════════════════╗"));
  console.log(chalk.bold.white("║") + chalk.bold.cyan("        🛡  TxGuard — Transaction Guard       ") + chalk.bold.white("║"));
  console.log(chalk.bold.white("║") + chalk.gray("    AI-powered safety layer for crypto agents  ") + chalk.bold.white("║"));
  console.log(chalk.bold.white("╚══════════════════════════════════════════╝"));
  console.log("");
  console.log(chalk.white("  Wallet : ") + chalk.cyan(label));
  console.log(chalk.white("  Coin   : ") + chalk.cyan(coin.toUpperCase()));
  console.log(chalk.white("  Balance: ") + chalk.green(`${balance} base units`));
  console.log("");
  console.log(chalk.gray("  Type a transaction request in plain English."));
  console.log(chalk.gray("  Examples:"));
  console.log(chalk.gray(`    • "Send 1000 satoshis to tb1qw508d6... for infra"`));
  console.log(chalk.gray(`    • "Send everything to 0x0000000000000000000000000000000000000000"`));
  console.log(chalk.gray(`    • "Transfer some funds to my new wallet"`));
  console.log(chalk.gray("  Type 'exit' to quit.\n"));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Validate BitGo credentials before starting the CLI
  process.stdout.write(chalk.gray("  Connecting to BitGo testnet..."));
  const authed = await verifyAuth();
  if (!authed) {
    process.stdout.write("\n");
    console.error(chalk.red("  ❌ BitGo auth failed. Check BITGO_ACCESS_TOKEN in .env"));
    process.exit(1);
  }
  process.stdout.write(chalk.green(" ✓\n"));

  process.stdout.write(chalk.gray("  Fetching wallet info..."));
  const wallet = await getWallet();
  process.stdout.write(chalk.green(" ✓\n"));

  // SOL returns *String fields; BTC returns numeric fields — handle both
  const spendable =
    wallet.spendableBalance ??
    (wallet.spendableBalanceString ? Number(wallet.spendableBalanceString) : undefined) ??
    wallet.balance ??
    (wallet.balanceString ? Number(wallet.balanceString) : 0);

  printBanner(wallet.coin, spendable, wallet.label ?? wallet.id);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Conversation history persists across turns for multi-step interactions
  // e.g. Claude asks "confirm address?" → user says "yes" → Claude executes
  const conversationHistory: Message[] = [];

  /** Recursive readline prompt — keeps the conversation going until "exit". */
  const prompt = () => {
    rl.question(chalk.bold.white("You: "), async (input) => {
      const trimmed = input.trim();

      if (!trimmed || trimmed.toLowerCase() === "exit") {
        console.log(chalk.gray("\n  Goodbye.\n"));
        rl.close();
        return;
      }

      console.log("");

      try {
        const { reply, updatedHistory } = await runAgent(
          trimmed,
          conversationHistory,
          (name, toolInput) => {
            console.log(formatToolCall(name, toolInput));
          },
          (name, result) => {
            console.log(formatToolResult(name, result as Record<string, unknown>));
          }
        );

        // Replace history in place (can't reassign const)
        conversationHistory.length = 0;
        conversationHistory.push(...updatedHistory);

        console.log("");
        console.log(chalk.bold.white("TxGuard: ") + reply);
        console.log("");
      } catch (err) {
        console.error(chalk.red(`\n  ❌ Error: ${String(err)}\n`));
      }

      prompt();
    });
  };

  // Gracefully handle stdin closing (e.g. piped input in tests)
  rl.on("close", () => process.exit(0));

  prompt();
}

main().catch((err) => {
  console.error(chalk.red(`Fatal error: ${err}`));
  process.exit(1);
});
