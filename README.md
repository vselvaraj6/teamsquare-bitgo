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
| OpenAI API key | — | Get one at platform.openai.com |

### Getting BitGo testnet credentials

1. Log in to [app.bitgo-test.com](https://app.bitgo-test.com)
2. Go to **Settings > Developer > Access Tokens** and create a new token
3. Create a wallet (or use an existing one) and copy the **Wallet ID** from wallet settings
4. Fund the testnet wallet using a BTC testnet faucet

### Getting an OpenAI API key

1. Log in to [platform.openai.com](https://platform.openai.com)
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
OPENAI_API_KEY=your_openai_api_key
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

## How intent is resolved

TxGuard does **not** use keyword matching, regex, or a rules engine to parse user input. Intent is resolved entirely by Claude:

1. The user's plain-English message is sent to Claude along with the three tool definitions and a system prompt
2. Claude reads the message and infers intent — recipient address, amount, coin type, memo — from natural language
3. Claude decides which tools to call based on that understanding and the rules in the system prompt
4. Tools execute real operations (BitGo API) and return structured results
5. Claude reads the results and decides what to do next: call another tool, ask the user to clarify, or give a final answer

**MCP's role** is purely the transport and schema layer — it defines how tools are described to Claude and how calls are exchanged. The reasoning about *which* tool to call and *why* is entirely Claude's LLM inference.

---

## Architecture

### Intent → Execution flow (CLI mode)

```mermaid
sequenceDiagram
    actor User
    participant CLI as CLI<br/>(index.ts)
    participant Agent as Agent Loop<br/>(agent.ts)
    participant Claude as Claude API<br/>(claude-sonnet-4-6)
    participant Executor as Tool Executor<br/>(executor.ts)
    participant BitGo as BitGo Testnet API

    User->>CLI: "Send 500 satoshis to 0xabc... for vendor"
    CLI->>Agent: runAgent(message, history)

    loop Agentic tool loop
        Agent->>Claude: POST /v1/messages<br/>(system prompt + tools + message)
        Note over Claude: Infers intent from NL:<br/>• recipient = 0xabc<br/>• amount = 500 sats<br/>• action = send<br/>Decides tool call order
        Claude-->>Agent: stop_reason: tool_use<br/>tool: get_wallet_balance

        Agent->>Executor: get_wallet_balance()
        Executor->>BitGo: GET /api/v2/tbtc/wallet/{id}
        BitGo-->>Executor: balance: 50000 sats
        Executor-->>Agent: {success, spendableBalance: 50000}

        Agent->>Claude: tool_result: {balance: 50000}
        Claude-->>Agent: stop_reason: tool_use<br/>tool: check_address_risk(0xabc)

        Agent->>Executor: check_address_risk("0xabc")
        Note over Executor: blocklist check<br/>whitelist check<br/>heuristic flags
        Executor-->>Agent: {risk: medium, blocked: false}

        Agent->>Claude: tool_result: {risk: medium}
        Note over Claude: Risk is medium → ask user<br/>to confirm before executing
        Claude-->>Agent: stop_reason: end_turn<br/>"Unrecognized address. Confirm?"
    end

    Agent-->>CLI: reply: "Unrecognized address. Confirm?"
    CLI->>User: "Unrecognized address. Confirm?"
    User->>CLI: "yes"

    CLI->>Agent: runAgent("yes", history)
    Agent->>Claude: POST /v1/messages (with full history)
    Claude-->>Agent: stop_reason: tool_use<br/>tool: execute_transaction(0xabc, 500)

    Agent->>Executor: execute_transaction("0xabc", 500)
    Note over Executor: Safety re-check (defense in depth):<br/>• check_address_risk again<br/>• verify balance >= 500
    Executor->>BitGo: POST /api/v2/tbtc/wallet/{id}/sendcoins
    BitGo-->>Executor: {txid: "def456", status: "signed"}
    Executor-->>Agent: {success: true, txid: "def456"}

    Agent->>Claude: tool_result: {txid: "def456"}
    Claude-->>Agent: stop_reason: end_turn<br/>"Executed. TX hash: def456"
    Agent-->>CLI: reply
    CLI->>User: "Executed. TX hash: def456"
```

### MCP mode (Claude Desktop or any agent)

```mermaid
flowchart TD
    A["Any MCP Client\n(Claude Desktop / AI Agent)"] -->|stdio transport| B

    subgraph B["TxGuard MCP Server\n(mcp-server.ts)"]
        direction TB
        T1["Tool: get_wallet_balance"]
        T2["Tool: check_address_risk"]
        T3["Tool: execute_transaction\n⚠️ safety re-check inside"]
    end

    T1 -->|GET /wallet| C[(BitGo Testnet API)]
    T2 --> D{Blocklist /\nWhitelist check}
    T3 -->|POST /sendcoins\nonly if safe| C

    D -->|blocked| E[Return: blocked=true\nNo BitGo call]
    D -->|clear| F[Return: risk level + flags]

    style E fill:#ff4444,color:#fff
    style B fill:#1a1a2e,color:#fff
    style C fill:#0f3460,color:#fff
```

### Safety layers

```mermaid
flowchart LR
    U([User / Agent]) --> NL["Natural language\nrequest"]
    NL --> LLM["Claude infers intent\n(address, amount, action)"]
    LLM --> T1["1. get_wallet_balance\ncheck funds available"]
    T1 --> T2["2. check_address_risk\nblocklist + heuristics"]
    T2 -->|blocked=true| BLOCK["🚫 BLOCKED\nno BitGo call ever"]
    T2 -->|risk=medium/high| CONFIRM["⚠️ Ask user\nto confirm"]
    T2 -->|risk=low / whitelisted| T3
    CONFIRM -->|user says yes| T3["3. execute_transaction\ninternal safety re-check"]
    CONFIRM -->|user says no| CANCEL["❌ Cancelled"]
    T3 -->|passes re-check| BITGO["BitGo sendcoins\ntestnet"]
    T3 -->|fails re-check| BLOCK2["🚫 BLOCKED\ndefense in depth"]
    BITGO --> HASH["✅ TX Hash returned"]

    style BLOCK fill:#ff4444,color:#fff
    style BLOCK2 fill:#ff4444,color:#fff
    style CANCEL fill:#ff8800,color:#fff
    style HASH fill:#00aa44,color:#fff
```

### Safety design

- **Defense in depth**: `check_address_risk` runs when Claude calls it *and* again inside `execute_transaction`. Blocked addresses never reach BitGo.
- **Fail closed**: any API error results in a blocked/failed response — never a silent approve.
- **Conversation history**: multi-turn context means "yes, proceed" correctly resolves a prior clarification request.
- **MCP as a safety boundary**: safety logic lives in the tool server, not the agent — swap the LLM or client and the guard stays.

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
| LLM | OpenAI `gpt-4o` via `openai` SDK |
| Crypto | BitGo testnet REST API |
| CLI | Node.js `readline` + `chalk` |
