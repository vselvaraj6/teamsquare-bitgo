import chalk from "chalk";
import { checkAddressOnChain } from "./src/riskApi.js";
import { toolCheckAddressRisk } from "./src/tools/executor.js";

const TESTS = [
  // Known ETH addresses
  { label: "Null address (EVM)",        addr: "0x0000000000000000000000000000000000000000" },
  { label: "Clean ETH address",         addr: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }, // vitalik.eth
  { label: "Solana wallet (our wallet)", addr: "76pA3FeZxQhK7FirsQSvsNdazNas9Y23VmzJYtFdeM72" },
  { label: "Short/invalid address",     addr: "0xabc" },
];

console.log(chalk.bold("\n── GoPlus API raw responses ──\n"));

for (const t of TESTS) {
  const result = await checkAddressOnChain(t.addr);
  console.log(chalk.cyan(`[${t.label}]`));
  console.log(`  supported : ${result.supported}`);
  console.log(`  found     : ${result.found}`);
  console.log(`  source    : ${result.source}`);
  if (result.flags) {
    const active = Object.entries(result.flags)
      .filter(([k, v]) => k !== "raw" && v === true)
      .map(([k]) => k);
    console.log(`  flags     : ${active.length ? active.join(", ") : "none"}`);
  }
  console.log();
}

console.log(chalk.bold("\n── Full toolCheckAddressRisk output ──\n"));

for (const t of TESTS) {
  const result = await toolCheckAddressRisk(t.addr);
  const color = result.blocked ? chalk.red : result.risk === "low" ? chalk.green : result.risk === "medium" ? chalk.yellow : chalk.red;
  console.log(color(`[${t.label}] risk=${result.risk} blocked=${result.blocked}`));
  console.log(`  flags  : ${result.flags.join(", ")}`);
  console.log(`  summary: ${result.summary}`);
  console.log();
}
