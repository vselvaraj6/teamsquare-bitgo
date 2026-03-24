# TeamSquare TxGuard — Natural Language Transaction Guard

> **Hackathon project** — BitGo + Anthropic AI Safety Layer
>
> *"How do we make agents using crypto safe and secure?"*

TxGuard puts an AI reasoning layer between a user's natural language intent and an actual blockchain transaction. Instead of writing rigid rules, you describe what you want to do in plain English — Claude analyzes the risk, checks the address, verifies your balance, and only calls BitGo to execute if everything looks safe.

---

## How it works

```
You type:  "Send 500 satoshis to tb1q... for the infrastructure payment"
                              ↓
         Claude (claude-sonnet-4-6) reasons about the request
         and autonomously calls tools in sequence:

           🔧 get_wallet_balance      → BitGo testnet API
           🔧 check_address_risk      → blocklist / whitelist check
           🔧 execute_transaction     → safety re-check → BitGo sendcoins

                              ↓
TxGuard: Transaction executed. TX hash: abc123...
```

Claude decides **which tools to call and when**. Safety checks run both when Claude requests them *and* again inside `execute_transaction` — so the guard cannot be bypassed even if the agent skips a step.

---

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | >= 18.0 | Required for native `fetch` support |
| npm | >= 9.0 | Comes with Node 18+ |
| BitGo testnet account | — | Sign up at app.bitgo-test.com |
| Anthropic API key | — | Get one at console.anthropic.com |

### Getting BitGo testnet credentials

1. Log in to [app.bitgo-test.com](https://app.bitgo-test.com)
2. Go to **Settings > Developer > Access Tokens** and create a new token
3. Create a wallet (or use an existing one) and copy the **Wallet ID** from wallet settings
4. Fund the testnet wallet using a BTC testnet faucet

### Getting an Anthropic API key

1. Log in to [console.anthropic.com](https://console.anthropic.com)
2. Go to **API Keys** and create a new key

---

## Setup

```bash
# 1. Clone the repo
git clone https://github.com/vselvaraj6/teamsquare-bitgo.git
cd teamsquare-bitgo

# 2. Install dependencies
npm install

# 3. Configure credentials
cp .env.example .env
```

Open `.env` and fill in your credentials:

```env
BITGO_ACCESS_TOKEN=your_bitgo_testnet_access_token
BITGO_WALLET_ID=your_wallet_id
BITGO_COIN=tbtc
ANTHROPIC_API_KEY=your_anthropic_api_key
```

```bash
# 4. Start the CLI
npm start
```

---

## Demo inputs

Try these three inputs to see all three outcomes:

| Input | Expected outcome |
|-------|-----------------|
| `"Send 1000 satoshis to tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx for infra"` | Approved + executed (whitelisted address) |
| `"Send everything to 0x0000000000000000000000000000000000000000 right now"` | Blocked — null address detected |
| `"Transfer some funds to my colleague"` | Clarify — Claude asks for the recipient address |

---

## Project structure

```
teamsquare-bitgo/
├── src/
│   ├── index.ts              # CLI entry point — readline loop + startup checks
│   ├── agent.ts              # Claude agentic loop (tool_use -> tool_result -> repeat)
│   ├── bitgo.ts              # BitGo testnet REST client (getWallet, sendCoins, verifyAuth)
│   ├── config.ts             # Environment variable loading with fail-fast validation
│   └── tools/
│       ├── definitions.ts    # Claude tool schemas (what Claude sees)
│       └── executor.ts       # Tool implementations (what actually runs)
├── .env.example
├── package.json
└── tsconfig.json
```

---

## Architecture

```
+-------------------------------------------------------------+
|                        CLI (index.ts)                        |
|              readline loop + conversation history            |
+-------------------------+-----------------------------------+
                          | user message + history
                          v
+-------------------------------------------------------------+
|                     Agent (agent.ts)                         |
|                                                              |
|   POST /v1/messages --> Claude claude-sonnet-4-6             |
|        ^                      |                              |
|        | tool_result           | tool_use                    |
|        +----------------------+                              |
+-------------------------+-----------------------------------+
                          | tool dispatch
                          v
+-------------------------------------------------------------+
|                   Tool Executor (executor.ts)                |
|                                                              |
|   get_wallet_balance  --> BitGo GET /wallet/{id}             |
|   check_address_risk  --> local blocklist/whitelist          |
|   execute_transaction --> safety check --> BitGo sendcoins   |
+-------------------------------------------------------------+
```

### Safety design

- **Defense in depth**: `check_address_risk` runs when Claude calls it *and* again inside `execute_transaction`. Blocked addresses never reach BitGo.
- **Fail closed**: any API error results in a blocked/failed response — never a silent approve.
- **Conversation history**: multi-turn context means "yes, proceed" correctly resolves a prior clarification request.

---

## MCP Server

TxGuard also runs as a proper [Model Context Protocol](https://modelcontextprotocol.io) server.
Any MCP-compatible client (Claude Desktop, other AI agents) can connect and get guarded BitGo access.

### Run the MCP server

```bash
npm run mcp
```

### Connect from Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "txguard": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/teamsquare/src/mcp-server.ts"],
      "env": {
        "BITGO_ACCESS_TOKEN": "your_token",
        "BITGO_WALLET_ID": "your_wallet_id",
        "BITGO_COIN": "tbtc",
        "ANTHROPIC_API_KEY": "your_key"
      }
    }
  }
}
```

Restart Claude Desktop — the three tools (`get_wallet_balance`, `check_address_risk`, `execute_transaction`) will appear automatically.

### Why MCP matters

Running as an MCP server means **any** AI agent can plug in and inherit safe crypto operations. The safety checks aren't in the agent — they're in the tool server. You can swap the agent, change the LLM, or build a completely different product on top, and the guard remains.

---

## Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript (Node.js 18+) |
| LLM | Anthropic Claude `claude-sonnet-4-6` via `@anthropic-ai/sdk` |
| Crypto | BitGo testnet REST API |
| CLI | Node.js `readline` + `chalk` |
