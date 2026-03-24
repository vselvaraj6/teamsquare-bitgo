/**
 * config.ts
 *
 * Loads and validates all environment variables at startup.
 * If any required variable is missing, the process exits immediately
 * with a clear error message rather than failing silently at runtime.
 */

import dotenv from "dotenv";
dotenv.config();

/** Reads a required env var; exits with a helpful message if absent. */
function require_env(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`❌ Missing required env var: ${name}`);
    console.error(`   Copy .env.example to .env and fill in your credentials.`);
    process.exit(1);
  }
  return val;
}

export const config = {
  bitgo: {
    /** Bearer token from your BitGo testnet account */
    accessToken: require_env("BITGO_ACCESS_TOKEN"),
    /** ID of the wallet to send from (found in BitGo dashboard) */
    walletId: require_env("BITGO_WALLET_ID"),
    /** Coin type, e.g. "tbtc" for testnet Bitcoin */
    coin: process.env.BITGO_COIN ?? "tbtc",
    /** BitGo testnet base URL — do NOT use app.bitgo.com in production */
    baseUrl: "https://app.bitgo-test.com",
  },
  anthropic: {
    /** Anthropic API key for Claude */
    apiKey: require_env("ANTHROPIC_API_KEY"),
  },
};
