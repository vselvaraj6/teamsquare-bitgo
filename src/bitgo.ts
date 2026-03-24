/**
 * bitgo.ts
 *
 * Thin HTTP client for the BitGo testnet REST API.
 * Covers the three operations needed for this demo:
 *   - verifyAuth   : confirm the access token is valid
 *   - getWallet    : fetch balance and wallet metadata
 *   - sendCoins    : broadcast a transaction
 *
 * All requests use a 10-second timeout via AbortController.
 * Errors from the API are thrown as plain Error objects with the
 * HTTP status and response body included for easy debugging.
 *
 * Docs: https://app.bitgo.com/docs/
 */

import { config } from "./config.js";

const { baseUrl, accessToken, walletId, coin } = config.bitgo;

/** Standard headers sent on every BitGo request */
const headers = {
  Authorization: `Bearer ${accessToken}`,
  "Content-Type": "application/json",
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WalletInfo {
  id: string;
  coin: string;
  label: string;
  // Numeric fields (BTC-family coins)
  balance: number;
  confirmedBalance: number;
  spendableBalance: number;
  // String fields (SOL and other coins return these instead)
  balanceString?: string;
  confirmedBalanceString?: string;
  spendableBalanceString?: string;
}

export interface SendCoinsResult {
  txid: string;
  status: string;
  transfer?: unknown;
}

export interface TransferInfo {
  id: string;
  txid: string;
  coin: string;
  wallet: string;
  to: string;
  from?: string;
  amount: number;
  value: number;
  usd?: number;
  state: string;
  confirmedTime?: string;
  comment?: string;
  label?: string;
}

export interface TransfersResponse {
  transfers: TransferInfo[];
  count: number;
}

export interface MarketData {
  latest: {
    currencies: {
      USD: {
        last: number;
      };
    };
  };
}

export interface FeeEstimate {
  feePerKb: number;
  cpfpFeePerKb: number;
  numBlocks: number;
}

export interface SendCoinsParams {
  address: string;
  /** Amount in base units: satoshis for BTC, drops for XRP, etc. */
  amount: number;
  memo?: string;
  /** Required by some BitGo wallet configs; omit if not set */
  walletPassphrase?: string;
}

// ─── Internal fetch wrapper ───────────────────────────────────────────────────

/**
 * Wraps fetch with auth headers and error handling.
 * Throws a descriptive Error if the response is not 2xx.
 */
async function bitgoFetch(path: string, options?: RequestInit) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { ...headers, ...(options?.headers ?? {}) },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`BitGo API error ${res.status}: ${body}`);
  }

  return res.json();
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Verifies the access token by calling /api/v2/user/me.
 * Returns false instead of throwing so the caller can show a friendly error.
 */
export async function verifyAuth(): Promise<boolean> {
  try {
    await bitgoFetch("/api/v2/user/me");
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetches wallet info including balance for the configured wallet ID.
 */
export async function getWallet(): Promise<WalletInfo> {
  const data = await bitgoFetch(`/api/v2/${coin}/wallet/${walletId}`) as WalletInfo;
  return data;
}

/**
 * Fetches the recent transaction history (transfers) for the configured wallet.
 * Returns a list of incoming and outgoing transfers.
 */
export async function getTransfers(limit: number = 10): Promise<TransfersResponse> {
  const data = await bitgoFetch(`/api/v2/${coin}/wallet/${walletId}/transfer?limit=${limit}`) as TransfersResponse;
  return data;
}

/**
 * Broadcasts a transaction from the configured wallet.
 * Amount must be in base units (satoshis for tBTC).
 * Returns the transaction ID and status on success.
 */
export async function sendCoins(params: SendCoinsParams): Promise<SendCoinsResult> {
  const body = {
    address: params.address,
    amount: params.amount,
    ...(params.memo ? { memo: params.memo } : {}),
    ...(params.walletPassphrase ? { walletPassphrase: params.walletPassphrase } : {}),
  };

  const data = await bitgoFetch(`/api/v2/${coin}/wallet/${walletId}/sendcoins`, {
    method: "POST",
    body: JSON.stringify(body),
  }) as SendCoinsResult;

  return data;
}
