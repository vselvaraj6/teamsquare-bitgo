/**
 * agent.ts
 *
 * Core agentic loop that powers TxGuard.
 *
 * How it works:
 *   1. User message + conversation history → Claude API (with tools)
 *   2. If Claude responds with tool_use blocks, execute each tool and feed
 *      the results back as tool_result blocks in the next message
 *   3. Repeat until Claude returns stop_reason: "end_turn" (final answer)
 *
 * Claude is instructed (via system prompt) to always call tools in the
 * correct safety order: get_wallet_balance → check_address_risk → execute_transaction.
 *
 * The loop is capped at 10 iterations to prevent infinite cycles.
 * Any unexpected stop reason returns a safe "could not complete" message.
 */

import Anthropic from "@anthropic-ai/sdk";
import chalk from "chalk";
import { config } from "./config.js";
import { TOOL_DEFINITIONS } from "./tools/definitions.js";
import { executeTool } from "./tools/executor.js";

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

/**
 * System prompt that defines Claude's role, rules, and tool usage order.
 * Keeping this strict and explicit produces consistent, predictable behavior.
 */
const SYSTEM_PROMPT = `You are TxGuard, a crypto transaction security agent. You protect users from risky or fraudulent transactions before they are executed.

Your job:
1. Analyze natural language transaction requests
2. Use your tools to gather information and assess risk
3. Make a clear approve / block / clarify decision
4. Execute only when safe and confirmed

Rules:
- ALWAYS call get_wallet_balance before any transaction
- ALWAYS call check_address_risk before calling execute_transaction
- If check_address_risk returns blocked: true, NEVER call execute_transaction — explain why it was blocked
- If risk is "medium" or higher and address is not whitelisted, ask the user to confirm before executing
- If the request is ambiguous (no address, no amount, unclear intent), ask for clarification before using any tools
- Be concise. One short paragraph max per response. No bullet points.
- When a transaction is blocked, explain clearly why and what the user can do instead
- When a transaction executes successfully, show the tx hash

You are the last line of defense before funds leave the wallet. Be thorough but not paranoid.`;

export type Message = Anthropic.MessageParam;

/**
 * Runs one turn of the agent loop.
 *
 * @param userMessage   - The user's plain-English input for this turn
 * @param history       - Full conversation history (mutated externally by index.ts)
 * @param onToolCall    - Callback fired when Claude requests a tool (for UI display)
 * @param onToolResult  - Callback fired after a tool executes (for UI display)
 * @returns             - Claude's final text reply and the updated message history
 */
export async function runAgent(
  userMessage: string,
  history: Message[],
  onToolCall: (name: string, input: Record<string, unknown>) => void,
  onToolResult: (name: string, result: object) => void
): Promise<{ reply: string; updatedHistory: Message[] }> {
  const messages: Message[] = [
    ...history,
    { role: "user", content: userMessage },
  ];

  let finalText = "";

  // Agentic loop: keep sending tool results back until Claude finishes
  for (let i = 0; i < 10; i++) {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: TOOL_DEFINITIONS,
      messages,
    });

    if (response.stop_reason === "end_turn") {
      // Claude is done — collect the final text block
      for (const block of response.content) {
        if (block.type === "text") {
          finalText = block.text;
        }
      }
      messages.push({ role: "assistant", content: response.content });
      break;
    }

    if (response.stop_reason === "tool_use") {
      // Claude wants to call one or more tools
      messages.push({ role: "assistant", content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type === "tool_use") {
          // Notify the UI that a tool is being called
          onToolCall(block.name, block.input as Record<string, unknown>);

          // Execute the tool and collect the result
          const result = await executeTool(
            block.name,
            block.input as Record<string, unknown>
          );

          // Notify the UI of the result
          onToolResult(block.name, result);

          // Package result for the next API call
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        }
      }

      // Feed all tool results back to Claude in a single user turn
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // Unexpected stop reason (e.g. max_tokens) — fail safely
    finalText = "Transaction analysis could not be completed. Please try again.";
    break;
  }

  return { reply: finalText, updatedHistory: messages };
}

// ─── UI Formatting Helpers ────────────────────────────────────────────────────

/** Formats a tool call event for terminal display (called by index.ts). */
export function formatToolCall(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "get_wallet_balance":
      return chalk.cyan("🔧 Checking wallet balance...");
    case "check_address_risk":
      return chalk.cyan(`🔧 Checking address risk: ${chalk.bold(input.address as string)}`);
    case "execute_transaction":
      return chalk.yellow(
        `🔧 Executing transaction: ${input.amount_satoshis} units → ${input.to}`
      );
    default:
      return chalk.cyan(`🔧 ${name}(${JSON.stringify(input)})`);
  }
}

/** Formats a tool result event for terminal display (called by index.ts). */
export function formatToolResult(name: string, result: Record<string, unknown>): string {
  switch (name) {
    case "get_wallet_balance": {
      if (!result.success) return chalk.red(`   ✗ Failed to fetch balance`);
      return chalk.green(`   ✓ Balance: ${result.balanceDisplay}`);
    }
    case "check_address_risk": {
      const risk = result.risk as string;
      const blocked = result.blocked as boolean;
      const color =
        blocked || risk === "critical" ? chalk.red
        : risk === "high" ? chalk.yellow
        : risk === "medium" ? chalk.blue
        : chalk.green;
      const icon = blocked ? "🚫" : risk === "low" ? "✅" : risk === "medium" ? "⚠️ " : "🔴";
      return color(`   ${icon} Risk: ${risk.toUpperCase()} — ${result.summary}`);
    }
    case "execute_transaction": {
      if (!result.success) return chalk.red(`   ✗ ${result.reason ?? result.error}`);
      return chalk.green(`   ✓ TX Hash: ${result.txid}`);
    }
    default:
      return chalk.gray(`   → ${JSON.stringify(result)}`);
  }
}
