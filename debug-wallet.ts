import { config } from "./src/config.js";
const { baseUrl, accessToken, walletId, coin } = config.bitgo;
const res = await fetch(`${baseUrl}/api/v2/${coin}/wallet/${walletId}`, {
  headers: { Authorization: `Bearer ${accessToken}` },
});
const w = await res.json();
console.log(JSON.stringify(w, null, 2));
