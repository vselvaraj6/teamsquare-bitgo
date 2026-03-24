/**
 * riskApi.ts
 *
 * Real-time address risk checking via the GoPlus Security API.
 * https://docs.gopluslabs.io/reference/api-overview
 *
 * GoPlus aggregates threat intelligence from multiple sources
 * (GoPlus, SlowMist, etc.) and returns risk flags per address.
 *
 * Free tier: 30 req/min, no API key required.
 * Optional: set GOPLUS_API_KEY in .env for higher rate limits.
 *
 * Address format → chain detection:
 *   0x + 40 hex chars  → EVM (ETH mainnet, chain_id=1)
 *   base58, 32–44 chars → Solana (chain_id=900)
 *   1/3/bc1...          → Bitcoin (GoPlus doesn't support BTC — skip API)
 */

const GOPLUS_BASE = "https://api.gopluslabs.io/api/v1";
const API_KEY = process.env.GOPLUS_API_KEY; // optional

export interface GoPlusFlags {
  /** Address has been flagged by threat intel sources */
  malicious: boolean;
  /** Involved in phishing campaigns */
  phishing: boolean;
  /** Involved in fund-stealing attacks */
  stealing: boolean;
  /** Associated with sanctioned entities */
  sanctioned: boolean;
  /** Linked to money laundering */
  moneyLaundering: boolean;
  /** Dark web transaction history */
  darkweb: boolean;
  /** Associated with mixer/tumbler services */
  mixer: boolean;
  /** Honeypot or scam token creator */
  honeypot: boolean;
  /** Cybercrime involvement */
  cybercrime: boolean;
  /** Raw response for debugging */
  raw: Record<string, string>;
}

export interface GoPlusResult {
  supported: boolean;      // false if chain not supported or API unavailable
  found: boolean;          // false if no data for this address (unknown = not flagged)
  flags: GoPlusFlags | null;
  source: string;          // e.g. "GoPlus" | "SlowMist" | "unavailable"
}

/**
 * Detects which GoPlus chain_id to use based on address format.
 * Returns null if the chain is not supported by GoPlus.
 */
function detectChainId(address: string): string | null {
  const trimmed = address.trim();

  // EVM address: 0x followed by exactly 40 hex characters
  if (/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    return "1"; // Ethereum mainnet — GoPlus has the most data here
  }

  // Solana address: base58 encoded, typically 32–44 characters
  // Base58 chars: 1-9, A-H, J-N, P-Z, a-k, m-z (no 0, O, I, l)
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)) {
    return "900"; // Solana mainnet
  }

  // Bitcoin addresses (P2PKH, P2SH, bech32) — GoPlus doesn't support BTC
  if (/^(1|3|bc1)[a-zA-Z0-9]{25,62}$/.test(trimmed)) {
    return null;
  }

  return null; // Unknown format
}

/**
 * Queries GoPlus Security API for real-time address risk data.
 *
 * Returns { supported: false } if:
 *   - Address format is not supported (BTC, unknown)
 *   - API is unreachable (network error, timeout)
 *   - Rate limit exceeded
 *
 * Returns { found: false } if GoPlus has no data on the address
 * (this is common for new/testnet addresses — not a risk signal).
 */
export async function checkAddressOnChain(address: string): Promise<GoPlusResult> {
  const chainId = detectChainId(address);

  if (!chainId) {
    return { supported: false, found: false, flags: null, source: "unsupported_chain" };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (API_KEY) {
    headers["Authorization"] = API_KEY;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout

    const res = await fetch(
      `${GOPLUS_BASE}/address_security/${encodeURIComponent(address)}?chain_id=${chainId}`,
      { headers, signal: controller.signal }
    );
    clearTimeout(timeout);

    if (!res.ok) {
      return { supported: true, found: false, flags: null, source: "api_error" };
    }

    const json = await res.json() as { code: number; message: string; result: Record<string, string> };

    // GoPlus returns code=1 for success
    if (json.code !== 1 || !json.result) {
      return { supported: true, found: false, flags: null, source: "no_data" };
    }

    const r = json.result;
    const isSet = (v: string | undefined) => v === "1";

    const flags: GoPlusFlags = {
      malicious:       isSet(r.malicious_address) || isSet(r.blacklist_doubt),
      phishing:        isSet(r.phishing_activities),
      stealing:        isSet(r.stealing_attack),
      sanctioned:      isSet(r.sanctioned),
      moneyLaundering: isSet(r.money_laundering),
      darkweb:         isSet(r.darkweb_transactions),
      mixer:           isSet(r.mixer),
      honeypot:        isSet(r.honeypot_related_address),
      cybercrime:      isSet(r.cybercrime),
      raw: r,
    };

    const anyFlagged = Object.entries(flags)
      .filter(([k]) => k !== "raw")
      .some(([, v]) => v === true);

    return {
      supported: true,
      found: anyFlagged || Object.keys(r).length > 0,
      flags,
      source: r.data_source || "GoPlus",
    };

  } catch (err) {
    // Network error or timeout — fail open (don't block based on unavailability)
    const msg = String(err);
    if (msg.includes("abort")) {
      return { supported: true, found: false, flags: null, source: "timeout" };
    }
    return { supported: true, found: false, flags: null, source: "unavailable" };
  }
}
