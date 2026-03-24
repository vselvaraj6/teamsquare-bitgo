import { config } from "./src/config.js";

const { baseUrl, accessToken, coin } = config.bitgo;

const res = await fetch(`${baseUrl}/api/v2/${coin}/wallet`, {
  headers: { Authorization: `Bearer ${accessToken}` },
});

const data = await res.json() as { wallets?: Array<{ id: string; label: string; coin: string; spendableBalance: number }> };

if (!data.wallets?.length) {
  console.log("No wallets found for coin:", coin);
  console.log("Try changing BITGO_COIN in .env (e.g. gteth, talgo, tbtc)");
} else {
  console.log(`Found ${data.wallets.length} wallet(s) for ${coin}:\n`);
  for (const w of data.wallets) {
    console.log(`  ID   : ${w.id}`);
    console.log(`  Label: ${w.label}`);
    console.log(`  Bal  : ${w.spendableBalance} base units`);
    console.log();
  }
}
