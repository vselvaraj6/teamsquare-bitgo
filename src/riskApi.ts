/**
 * riskApi.ts
 *
 * Two-layer real-time address risk checking:
 *
 * Layer 1 — GoPlus Security API (primary)
 *   https://docs.gopluslabs.io/reference/api-overview
 *   Free, no API key required, 30 req/min.
 *   Returns automated threat intelligence flags (malicious, phishing,
 *   sanctioned, darkweb, money laundering, mixer, honeypot, cybercrime).
 *
 * Layer 2 — ChainAbuse API (enrichment)
 *   https://docs.chainabuse.com
 *   Community-reported scam cases. Called when GoPlus flags an address
 *   OR when the address is unrecognized, to surface real victim reports.
 *   Requires CHAINABUSE_API_KEY in .env (free at chainabuse.com).
 *   Rate limit: 10 req/month free tier — used selectively.
 *
 * Both APIs fail open: unavailability never blocks a transaction.
 */

// ─── GoPlus ───────────────────────────────────────────────────────────────────

const GOPLUS_BASE = "https://api.gopluslabs.io/api/v1";
const GOPLUS_API_KEY = process.env.GOPLUS_API_KEY; // optional, for higher rate limits

export interface GoPlusFlags {
  malicious: boolean;
  phishing: boolean;
  stealing: boolean;
  sanctioned: boolean;
  moneyLaundering: boolean;
  darkweb: boolean;
  mixer: boolean;
  honeypot: boolean;
  cybercrime: boolean;
  raw: Record<string, string>;
}

export interface GoPlusResult {
  supported: boolean;
  found: boolean;
  flags: GoPlusFlags | null;
  source: string;
}

/**
 * Detects which GoPlus chain_id to use based on address format.
 * Returns null for unsupported formats (BTC, unknown).
 */
function detectChainId(address: string): string | null {
  const t = address.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(t))         return "1";   // EVM / Ethereum mainnet
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t)) return "900"; // Solana
  return null;
}

/** Queries GoPlus for automated threat intelligence on an address. */
export async function checkAddressOnChain(address: string): Promise<GoPlusResult> {
  const chainId = detectChainId(address);
  if (!chainId) {
    return { supported: false, found: false, flags: null, source: "unsupported_chain" };
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (GOPLUS_API_KEY) headers["Authorization"] = GOPLUS_API_KEY;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(
      `${GOPLUS_BASE}/address_security/${encodeURIComponent(address)}?chain_id=${chainId}`,
      { headers, signal: controller.signal }
    );
    clearTimeout(timer);

    if (!res.ok) return { supported: true, found: false, flags: null, source: "api_error" };

    const json = await res.json() as { code: number; result: Record<string, string> };
    if (json.code !== 1 || !json.result) {
      return { supported: true, found: false, flags: null, source: "no_data" };
    }

    const r = json.result;
    const is = (v: string | undefined) => v === "1";

    const flags: GoPlusFlags = {
      malicious:       is(r.malicious_address) || is(r.blacklist_doubt),
      phishing:        is(r.phishing_activities),
      stealing:        is(r.stealing_attack),
      sanctioned:      is(r.sanctioned),
      moneyLaundering: is(r.money_laundering),
      darkweb:         is(r.darkweb_transactions),
      mixer:           is(r.mixer),
      honeypot:        is(r.honeypot_related_address),
      cybercrime:      is(r.cybercrime),
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
    const source = String(err).includes("abort") ? "timeout" : "unavailable";
    return { supported: true, found: false, flags: null, source };
  }
}

// ─── ChainAbuse ───────────────────────────────────────────────────────────────

const CHAINABUSE_BASE = "https://api.chainabuse.com/v0";
const CHAINABUSE_API_KEY = process.env.CHAINABUSE_API_KEY;

export interface ChainAbuseReport {
  id: string;
  scamCategory: string;         // e.g. "RANSOMWARE", "PHISHING", "RUG_PULL"
  description: string;
  amountLost: number | null;    // USD value reported lost
  currency: string | null;
  createdAt: string;
}

export interface ChainAbuseResult {
  available: boolean;           // false if no API key or request failed
  reportCount: number;
  totalLostUsd: number;         // sum of all reported losses in USD
  categories: string[];         // unique scam categories reported
  reports: ChainAbuseReport[];  // up to 5 most recent reports
  url: string;                  // link to full report page for demo
}

/**
 * Queries ChainAbuse for community-reported scam cases on this address.
 * Only called when GoPlus flags an address OR the address is unrecognized —
 * to conserve the 10 req/month free tier limit.
 *
 * Returns { available: false } if CHAINABUSE_API_KEY is not set.
 */
export async function checkAddressOnChainAbuse(address: string): Promise<ChainAbuseResult> {
  const empty: ChainAbuseResult = {
    available: false, reportCount: 0, totalLostUsd: 0,
    categories: [], reports: [], url: "",
  };

  if (!CHAINABUSE_API_KEY) return empty;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(
      `${CHAINABUSE_BASE}/reports?address=${encodeURIComponent(address)}`,
      {
        headers: { apiKey: CHAINABUSE_API_KEY, "Content-Type": "application/json" },
        signal: controller.signal,
      }
    );
    clearTimeout(timer);

    if (!res.ok) return { ...empty, available: true };

    const json = await res.json() as {
      reports?: Array<{
        id: string;
        scamCategory?: string;
        description?: string;
        outputAmount?: number;
        outputCurrency?: string;
        createdAt?: string;
      }>;
    };

    const raw = json.reports ?? [];
    if (raw.length === 0) {
      return { ...empty, available: true, url: `https://www.chainabuse.com/address/${address}` };
    }

    const reports: ChainAbuseReport[] = raw.slice(0, 5).map((r) => ({
      id: r.id,
      scamCategory: r.scamCategory ?? "UNKNOWN",
      description: (r.description ?? "").slice(0, 200),
      amountLost: r.outputAmount ?? null,
      currency: r.outputCurrency ?? null,
      createdAt: r.createdAt ?? "",
    }));

    const totalLostUsd = raw.reduce((sum, r) => {
      if (r.outputCurrency === "USD" && r.outputAmount) return sum + r.outputAmount;
      return sum;
    }, 0);

    const categories = [...new Set(raw.map((r) => r.scamCategory ?? "UNKNOWN"))];

    return {
      available: true,
      reportCount: raw.length,
      totalLostUsd,
      categories,
      reports,
      url: `https://www.chainabuse.com/address/${address}`,
    };
  } catch {
    return { ...empty, available: true };
  }
}
