// Scrape mainnet blocks and emit one compact JSONL record per transaction.
//
// Usage:  node src/ingest.mjs --blocks 200 --stride 20 --out data/txs.jsonl
//         RPC_URL=https://... node src/ingest.mjs --blocks 500
//
// Records carry everything the aggregator needs, including consumed CU and the
// ACTUAL loaded-accounts-data-size cost (recovered from meta.costUnits), which
// lets us model the "if everyone requested accurately" scenario from real data.

import fs from "node:fs";
import path from "node:path";
import { redact } from "./env.mjs";
import { getBlock, getSlot } from "./rpc.mjs";
import { requestedCostUnits, staticCost, parseBudget, COMPUTE_BUDGET_ID, VOTE_ID } from "./costModel.mjs";
import { splitTodayFee } from "./fees.mjs";

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf("--" + n);
  return i >= 0 ? argv[i + 1] : d;
};

const RPC = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const BLOCKS = Number(arg("blocks", 100));
const STRIDE = Number(arg("stride", 25)); // sample every Nth slot to spread across time
const CONC = Number(arg("conc", 4));
const OUT = arg("out", "data/txs.jsonl");

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const out = fs.createWriteStream(OUT, { flags: "w" });

const FROM = arg("from", null); // explicit slot range (e.g. one full epoch)
const TO = arg("to", null);

let slots;
if (FROM && TO) {
  const from = Number(FROM), to = Number(TO);
  // NOTE: the leader schedule gives each leader 4 consecutive slots. A stride that
  // is a multiple of 4 would sample the same position in every leader's window and
  // alias with leader rotation, so STRIDE must be coprime with 4.
  if (STRIDE % 2 === 0) {
    console.error(`stride ${STRIDE} is even -- it aliases with the 4-slot leader schedule. Use an odd stride.`);
    process.exit(1);
  }
  slots = [];
  for (let s = from; s <= to && slots.length < BLOCKS; s += STRIDE) slots.push(s);
} else {
  const tip = await getSlot(RPC);
  const startSlot = tip - 100; // stay behind the tip so blocks are finalized
  slots = Array.from({ length: BLOCKS }, (_, i) => startSlot - i * STRIDE);
}

const spanSlots = slots.length ? Math.abs(slots[slots.length - 1] - slots[0]) : 0;
console.log(`RPC    : ${redact(RPC)}`);
console.log(`range  : ${Math.min(slots[0], slots[slots.length - 1])} -> ${Math.max(slots[0], slots[slots.length - 1])}`);
console.log(`slots  : ${slots.length} samples, stride ${STRIDE}, spanning ${spanSlots.toLocaleString()} slots (~${((spanSlots * 0.4) / 3600).toFixed(1)} h of chain)`);

let done = 0, txCount = 0, emptySlots = 0, mismatch = 0;
const failed = [];
let cursor = 0;

function label(programs) {
  // dominant program = last top-level non-ComputeBudget instruction
  for (let i = programs.length - 1; i >= 0; i--) {
    if (programs[i] !== COMPUTE_BUDGET_ID) return programs[i];
  }
  return programs[programs.length - 1] || "unknown";
}

async function worker() {
  while (cursor < slots.length) {
    const slot = slots[cursor++];
    let block;
    try {
      block = await getBlock(RPC, slot);
    } catch (e) {
      // RPC gave up after retries. These are NOT random -- they cluster when the
      // endpoint throttles -- so they are counted and reported, never swallowed.
      failed.push(slot);
      continue;
    }
    if (!block) { emptySlots++; continue; } // leader produced no block for this slot

    const lines = [];
    for (const tx of block.transactions) {
      const meta = tx.meta;
      if (!meta) continue;
      const b = parseBudget(tx);
      const rc = requestedCostUnits(tx); // mainnet today: vote NOT migrated
      // scenario: once bls_pubkey_management_in_vote_account activates, vote
      // instructions jump from the 3k builtin bucket to the 200k default bucket
      const rcVm = requestedCostUnits(tx, { voteMigrated: true });
      const t = splitTodayFee(tx);

      // recover the ACTUAL loaded-data-size cost from agave's own accounting
      let actualLoaded = null;
      if (meta.costUnits != null && meta.computeUnitsConsumed != null) {
        const r = meta.costUnits - staticCost(tx, b) - meta.computeUnitsConsumed;
        if (r >= 0 && r % 8 === 0) actualLoaded = r;
        else mismatch++;
      }

      const isVote = b.programs.includes(VOTE_ID);
      lines.push(JSON.stringify({
        sl: slot,
        v: isVote ? 1 : 0,
        s: t.numSigs,
        f: t.actual,          // today's total fee (ground truth)
        p: t.priority,        // priority component
        cu: rc.total,         // requested_cost_units  <-- the SIMD-0553 base
        cuvm: rcVm.total,     // same, if the vote-migration feature were active
        g: rc.sig, w: rc.writeLock, d: rc.data, c: rc.cu, l: rc.loaded,
        cons: meta.computeUnitsConsumed ?? null,
        al: actualLoaded,     // actual loaded-data-size cost
        sc: b.setsCuLimit ? 1 : 0,
        sl2: b.setsLoadedSize ? 1 : 0,
        e: meta.err ? 1 : 0,
        pr: label(b.programs),
      }));
      txCount++;
    }
    out.write(lines.join("\n") + "\n");
    done++;
    if (done % 10 === 0) process.stdout.write(`\r  blocks ${done}/${BLOCKS}  txs ${txCount}   `);
  }
}

await Promise.all(Array.from({ length: CONC }, worker));
out.end();
await new Promise((r) => out.on("finish", r));

const coverage = (done / slots.length) * 100;
console.log(`\ndone. blocks=${done}/${slots.length} (${coverage.toFixed(2)}% coverage)`);
console.log(`emptySlots=${emptySlots} rpcFailed=${failed.length} txs=${txCount} costUnitsMismatch=${mismatch}`);
if (failed.length) console.log(`WARNING: ${failed.length} slots dropped by RPC; sample is not uniform over the range.`);

fs.writeFileSync(OUT.replace(/\.jsonl$/, "") + ".meta.json", JSON.stringify({
  rpcHost: new URL(RPC).host,
  slotsRequested: slots.length,
  slotFrom: slots[0], slotTo: slots[slots.length - 1], stride: STRIDE,
  blocks: done, emptySlots, rpcFailed: failed.length,
  failedSlots: failed.slice(0, 500),
  transactions: txCount, coveragePct: coverage,
}, null, 1));
console.log(`wrote ${OUT}`);
