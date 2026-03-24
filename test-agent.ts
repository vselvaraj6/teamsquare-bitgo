/**
 * test-agent.ts — runs the three demo flows directly against GPT-4o + BitGo
 * without the readline CLI layer.
 */

import chalk from "chalk";
import { runAgent, formatToolCall, formatToolResult } from "./src/agent.js";
import type { Message } from "./src/agent.js";

const TESTS = [
  {
    label: "Test 1 — BLOCK: null address",
    input: "Send 1000 lamports to 0x0000000000000000000000000000000000000000 right now",
  },
  {
    label: "Test 2 — CLARIFY: ambiguous request",
    input: "Transfer some funds to my colleague",
  },
  {
    label: "Test 3 — APPROVE: wallet balance check",
    input: "What is my current wallet balance?",
  },
];

for (const test of TESTS) {
  console.log("\n" + chalk.bold.yellow("─".repeat(60)));
  console.log(chalk.bold.white(test.label));
  console.log(chalk.gray(`Input: "${test.input}"`));
  console.log(chalk.yellow("─".repeat(60)));

  const history: Message[] = [];

  const { reply } = await runAgent(
    test.input,
    history,
    (name, input) => console.log(formatToolCall(name, input)),
    (name, result) => console.log(formatToolResult(name, result as Record<string, unknown>))
  );

  console.log("\n" + chalk.bold.white("TxGuard: ") + reply);
}

console.log("\n" + chalk.green("✓ All tests completed\n"));
