/**
 * tools/definitions.ts
 *
 * Declares the three tools that Claude can call during a conversation.
 * These are passed directly to the Anthropic Messages API as the `tools` parameter.
 *
 * Tool call order enforced by the system prompt:
 *   1. get_wallet_balance   — always first, confirms funds are available
 *   2. check_address_risk   — always before execution, flags unsafe destinations
 *   3. execute_transaction  — only after the above two pass
 *
 * Implementations live in executor.ts.
 */

import Anthropic from "@anthropic-ai/sdk";

export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "get_wallet_balance",
    description:
      "Fetch the current wallet balance and basic wallet info from BitGo. " +
      "Always call this before any transaction to check available funds.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "check_address_risk",
    description:
      "Check if a crypto address is safe to send to. " +
      "Returns a risk level (low/medium/high/critical), any flags, and whether the address is hard-blocked. " +
      "Always call this before execute_transaction.",
    input_schema: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description: "The recipient crypto address to check",
        },
      },
      required: ["address"],
    },
  },
  {
    name: "execute_transaction",
    description:
      "Execute a crypto transaction via BitGo after safety checks have passed. " +
      "Only call this after get_wallet_balance and check_address_risk confirm it is safe. " +
      "Requires explicit user confirmation if risk is medium or higher.",
    input_schema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Recipient address",
        },
        amount_satoshis: {
          type: "number",
          description: "Amount in base units (satoshis for BTC, drops for XRP, etc.)",
        },
        memo: {
          type: "string",
          description: "Optional memo or note for the transaction",
        },
      },
      required: ["to", "amount_satoshis"],
    },
  },
];
