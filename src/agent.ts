/**
 * agent.ts
 *
 * Core agentic loop powered by OpenAI function calling.
 *
 * How it works:
 *   1. User message + conversation history → OpenAI chat.completions.create() (with tools)
 *   2. If finish_reason === "tool_calls", execute each requested function and
 *      append a role:"tool" message with the result for each call
 *   3. Repeat until finish_reason === "stop" (final answer)
 *
 * OpenAI tool call format differs from Anthropic:
 *   - Tool requests:  message.tool_calls[].function.{name, arguments (JSON string)}
 *   - Tool results:   { role: "tool", tool_call_id, content: string }
 *
 * The loop is capped at 10 iterations to prevent infinite cycles.
 */

import OpenAI from "openai";
import chalk from "chalk";
import { config } from "./config.js";
import { TOOL_DEFINITIONS } from "./tools/definitions.js";
import { executeTool } from "./tools/executor.js";

const openai = new OpenAI({ apiKey: config.openai.apiKey });

/**
 * System prompt defining the agent's role and tool usage rules.
 * Identical intent to the previous Claude system prompt — model-agnostic.
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

export type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/**
 * Runs one turn of the agent loop.
 *
 * @param userMessage   - The user's plain-English input for this turn
 * @param history       - Full conversation history
 * @param onToolCall    - Callback fired when the model requests a tool (for UI display)
 * @param onToolResult  - Callback fired after a tool executes (for UI display)
 * @returns             - Model's final text reply and the updated message history
 */
export async function runAgent(
  userMessage: string,
  history: Message[],
  onToolCall: (name: string, input: Record<string, unknown>) => void,
  onToolResult: (name: string, result: object) => void
): Promise<{ reply: string; updatedHistory: Message[] }> {
  const messages: Message[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: userMessage },
  ];

  let finalText = "";

  // Agentic loop: keep sending tool results back until the model finishes
  for (let i = 0; i < 10; i++) {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      tools: TOOL_DEFINITIONS,
      messages,
    });

    const choice = response.choices[0];

    if (choice.finish_reason === "stop") {
      // Model is done — collect the final text
      finalText = choice.message.content ?? "";
      messages.push({ role: "assistant", content: finalText });
      break;
    }

    if (choice.finish_reason === "tool_calls") {
      // Model wants to call one or more tools
      const assistantMessage = choice.message;
      messages.push(assistantMessage); // append assistant turn with tool_calls

      for (const toolCall of assistantMessage.tool_calls ?? []) {
        if (toolCall.type !== "function") continue;
        const name = toolCall.function.name;
        // OpenAI returns arguments as a JSON string — parse it
        const input = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;

        // Notify the UI that a tool is being called
        onToolCall(name, input);

        // Execute the tool
        const result = await executeTool(name, input);

        // Notify the UI of the result
        onToolResult(name, result);

        // Append tool result as a role:"tool" message (OpenAI format)
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        });
      }
      continue;
    }

    // Unexpected finish reason — fail safely
    finalText = "Transaction analysis could not be completed. Please try again.";
    break;
  }

  // Return history without the system prompt (we re-add it each turn)
  const updatedHistory = messages.filter((m) => m.role !== "system");
  return { reply: finalText, updatedHistory };
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
  const indent = "   ";
  switch (name) {
    case "get_wallet_balance": {
      if (!result.success) return chalk.red(`${indent}✗ Failed to fetch balance`);
      return chalk.cyan(`${indent}💰 Available: `) + chalk.green.bold(result.balanceDisplay);
    }

    case "check_address_risk": {
      const risk = (result.risk as string).toUpperCase();
      const blocked = result.blocked as boolean;
      const flags = (result.flags as string[]) || [];
      const address = result.address as string;

      const color =
        blocked || risk === "CRITICAL" ? chalk.red
        : risk === "HIGH" ? chalk.yellow
        : risk === "MEDIUM" ? chalk.blue
        : chalk.green;

      const statusIcon = blocked ? "🚫 BLOCKED" : risk === "LOW" ? "✅ APPROVED" : "⚠️  CAUTION";

      const lines = [
        color(`┌──────────────────────────────────────────────────┐`),
        color(`│             🛡️  ADDRESS SAFETY REPORT             │`),
        color(`├──────────────────────────────────────────────────┤`),
        color(`│  Address: `) + chalk.white(address.length > 38 ? address.slice(0, 35) + "..." : address.padEnd(38)) + color(` │`),
        color(`│  Risk   : `) + chalk.bold(risk.padEnd(38)) + color(` │`),
        color(`│  Status : `) + chalk.bold(statusIcon.padEnd(38)) + color(` │`),
      ];

      if (flags.length > 0) {
        lines.push(color(`├──────────────────────────────────────────────────┤`));
        lines.push(color(`│  Flags  : `) + chalk.gray(flags.join(", ").padEnd(38)) + color(` │`));
      }

      lines.push(color(`└──────────────────────────────────────────────────┘`));

      return lines.map(l => indent + l).join("\n");
    }

    case "execute_transaction": {
      if (!result.success) {
        return chalk.red(`${indent}❌ TRANSACTION FAILED`) + "\n" +
               chalk.red(`${indent}   Reason: ${result.reason ?? result.error}`);
      }
      return chalk.green.bold(`${indent}🚀 TRANSACTION EXECUTED SUCCESSFULLY`) + "\n" +
             chalk.cyan(`${indent}   TX Hash: `) + chalk.white(result.txid) + "\n" +
             chalk.cyan(`${indent}   Amount : `) + chalk.white(`${result.amount_satoshis} satoshis`);
    }

    default:
      return chalk.gray(`${indent}→ ${JSON.stringify(result)}`);
  }
}
