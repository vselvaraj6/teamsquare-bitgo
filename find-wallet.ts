import { config } from "./src/config.js";

const { baseUrl, accessToken } = config.bitgo;
const walletId = config.bitgo.walletId;

// Common testnet coin types to try
const coins = ["tbtc", "gteth", "talgo", "tpolygon", "txrp", "tltc", "tsol"];

console.log(`Searching for wallet ${walletId} across coin types...\n`);

for (const coin of coins) {
  try {
    const res = await fetch(`${baseUrl}/api/v2/${coin}/wallet/${walletId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.ok) {
      const w = await res.json() as { id: string; label: string; coin: string; spendableBalance: number };
      console.log(`✓ Found! Coin: ${coin}`);
      console.log(`  Label  : ${w.label}`);
      console.log(`  Balance: ${w.spendableBalance} base units`);
      console.log(`\n→ Set BITGO_COIN=${coin} in your .env`);
      break;
    }
  } catch {
    // not this coin, try next
  }
  process.stdout.write(`  ${coin}: not found\n`);
}
