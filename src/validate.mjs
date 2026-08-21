// Validates the cost-model port against real mainnet blocks.
//
// agave sets meta.costUnits = signature + write_lock + data_bytes
//                           + ACTUAL consumed CU + ACTUAL loaded-data-size cost.
// We can compute the first three exactly. So:
//     residual = meta.costUnits - staticCost - computeUnitsConsumed
// must be the actual loaded-accounts-data-size cost, which is always
// pages * DEFAULT_HEAP_COST -> a NON-NEGATIVE MULTIPLE OF 8.
//
// If that holds across every transaction in a block, signature_cost,
// write_lock_cost and data_bytes_cost are all provably correct.

import { parseBudget, staticCost, DEFAULT_HEAP_COST } from "./costModel.mjs";
import { getBlock, getSlot } from "./rpc.mjs";

const RPC = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const N = Number(process.argv[2] || 3);

let total = 0, ok = 0, negative = 0, notMul8 = 0, skipped = 0;
const failures = [];

const tip = await getSlot(RPC);
let slot = tip - 80;
let scanned = 0;

while (scanned < N) {
  let block;
  try {
    block = await getBlock(RPC, slot);
  } catch (e) {
    slot--;
    continue;
  }
  if (!block) { slot--; continue; }
  scanned++;
  for (const tx of block.transactions) {
    if (tx.meta?.costUnits == null || tx.meta?.computeUnitsConsumed == null) { skipped++; continue; }
    total++;
    const b = parseBudget(tx);
    const residual = tx.meta.costUnits - staticCost(tx, b) - tx.meta.computeUnitsConsumed;
    if (residual < 0) {
      negative++;
      if (failures.length < 5) failures.push({ why: "negative", residual, sig: tx.transaction.signatures[0] });
    } else if (residual % DEFAULT_HEAP_COST !== 0) {
      notMul8++;
      if (failures.length < 5) failures.push({ why: "not mult of 8", residual, sig: tx.transaction.signatures[0] });
    } else {
      ok++;
    }
  }
  slot--;
}

console.log(`blocks scanned : ${scanned}`);
console.log(`transactions   : ${total}  (skipped ${skipped} missing meta)`);
console.log(`PASS           : ${ok}  (${((ok / total) * 100).toFixed(3)}%)`);
console.log(`negative resid : ${negative}`);
console.log(`not mult of 8  : ${notMul8}`);
if (failures.length) console.log("samples:", JSON.stringify(failures, null, 1));
