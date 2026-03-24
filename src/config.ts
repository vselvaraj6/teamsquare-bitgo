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
    /** Coin type, e.g. "tsol" for testnet Solana */
    coin: process.env.BITGO_COIN ?? "tbtc",
    /**
     * BitGo API base URL.
     * Read operations (balance, transfers) → app.bitgo-test.com
     * Write operations (sendcoins) require BitGo Express → localhost:3080
     * Set BITGO_EXPRESS_URL to your local Express instance for transactions.
     */
    baseUrl: "https://app.bitgo-test.com",
    expressUrl: process.env.BITGO_EXPRESS_URL ?? "http://localhost:3080",
    /** Wallet passphrase — required by BitGo Express to decrypt the user key for signing */
    walletPassphrase: process.env.BITGO_WALLET_PASSPHRASE ?? "",
  },
  openai: {
    /** OpenAI API key */
    apiKey: require_env("OPENAI_API_KEY"),
  },
};
