/**
 * riskApi.ts
 *
 * Real-time address risk checking via ChainAbuse API:
 *   https://docs.chainabuse.com
 *   Community-reported scam cases.
 *   Requires CHAINABUSE_API_KEY in .env (free at chainabuse.com).
 *
 * Fails open: API unavailability never blocks a transaction.
 */

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
