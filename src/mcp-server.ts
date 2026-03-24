/**
 * mcp-server.ts
 *
 * A Model Context Protocol (MCP) server that exposes BitGo wallet operations
 * as guarded tools. Any MCP-compatible client (Claude Desktop, other AI agents)
 * can connect to this server and get safe, AI-checked crypto operations.
 *
 * Transport: stdio (standard MCP convention for local servers)
 *
 * Exposed tools:
 *   - get_wallet_balance     : fetch live balance from BitGo testnet
 *   - check_address_risk     : evaluate recipient address safety
 *   - execute_transaction    : send funds (with enforced safety checks)
 *
 * Safety guarantee: execute_transaction re-runs check_address_risk internally.
 * A blocked address can NEVER reach BitGo sendcoins, even if the calling agent
 * skips the check_address_risk step.
 *
 * Usage:
 *   npm run mcp
 *   # or
 *   npx tsx src/mcp-server.ts
 *
 * To connect from Claude Desktop, add to claude_desktop_config.json:
 *   {
 *     "mcpServers": {
 *       "txguard": {
 *         "command": "npx",
 *         "args": ["tsx", "/absolute/path/to/teamsquare/src/mcp-server.ts"],
 *         "env": {
 *           "BITGO_ACCESS_TOKEN": "...",
 *           "BITGO_WALLET_ID": "...",
 *           "BITGO_COIN": "tbtc",
 *           "ANTHROPIC_API_KEY": "..."
 *         }
 *       }
 *     }
 *   }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  toolGetWalletBalance,
  toolCheckAddressRisk,
  toolExecuteTransaction,
} from "./tools/executor.js";

// ─── Server setup ─────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "txguard",
  version: "1.0.0",
});

// ─── Tool: get_wallet_balance ─────────────────────────────────────────────────

server.tool(
  "get_wallet_balance",
  "Fetch the current wallet balance and basic wallet info from BitGo testnet. " +
    "Call this before any transaction to verify available funds.",
  {}, // no input parameters
  async () => {
    const result = await toolGetWalletBalance();
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ─── Tool: check_address_risk ─────────────────────────────────────────────────

server.tool(
  "check_address_risk",
  "Check whether a crypto address is safe to send funds to. " +
    "Returns risk level (low/medium/high/critical), flags, and whether the address is hard-blocked. " +
    "Always call this before execute_transaction.",
  {
    address: z.string().describe("The recipient crypto address to evaluate"),
  },
  async ({ address }) => {
    const result = toolCheckAddressRisk(address);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ─── Tool: execute_transaction ────────────────────────────────────────────────

server.tool(
  "execute_transaction",
  "Execute a crypto transaction via BitGo after safety checks pass. " +
    "Internally re-runs check_address_risk and balance verification — " +
    "blocked addresses are rejected even if you skip the explicit check step. " +
    "Amount must be in base units (satoshis for BTC).",
  {
    to: z.string().describe("Recipient address"),
    amount_satoshis: z
      .number()
      .positive()
      .describe("Amount in base units (satoshis for BTC, drops for XRP, etc.)"),
    memo: z.string().optional().describe("Optional memo or note for the transaction"),
  },
  async ({ to, amount_satoshis, memo }) => {
    const result = await toolExecuteTransaction(to, amount_satoshis, memo);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);

// Log to stderr so it doesn't corrupt the stdio MCP stream
process.stderr.write("TxGuard MCP server running on stdio\n");
