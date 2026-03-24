import { verifyAuth, getWallet } from "./src/bitgo.js";

console.log("Checking BitGo connection...");
const authed = await verifyAuth();
console.log("BitGo auth:", authed ? "✓ OK" : "✗ FAILED — check BITGO_ACCESS_TOKEN");

if (authed) {
  const wallet = await getWallet();
  console.log("Wallet label:", wallet.label ?? wallet.id);
  console.log("Coin:", wallet.coin);
  console.log("Spendable balance:", wallet.spendableBalance ?? wallet.balance, "base units");
  console.log("\n✓ Ready. Run: npm start");
}
