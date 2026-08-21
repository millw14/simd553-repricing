// Turn the JSONL scrape into summary.json for the dashboard.
//
//   node src/aggregate.mjs --in data/txs.jsonl --out web/summary.json

import fs from "node:fs";
import readline from "node:readline";
import { GATES, BASE_INCLUSION_FEE, resourceFee } from "./fees.mjs";
import { PROGRAM_LABELS } from "./programs.mjs";

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : d; };
const IN = arg("in", "data/txs.jsonl");
const OUT = arg("out", "web/summary.json");

const SLOTS_PER_DAY = 216_000; // 400ms slots
const LAMPORTS_PER_SOL = 1e9;
const CU_HEADROOM = 1.1; // "optimized" scenario: request 10% above what you actually burned

const pct = (n, d) => (d ? (n / d) * 100 : 0);
const percentile = (sorted, p) => {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[i];
};

// percent-change buckets for the distribution chart
const BUCKETS = [
  { k: "<-50%", lo: -Infinity, hi: -50 },
  { k: "-50..-25%", lo: -50, hi: -25 },
  { k: "-25..-10%", lo: -25, hi: -10 },
  { k: "-10..0%", lo: -10, hi: -0.0001 },
  { k: "no change", lo: -0.0001, hi: 0.0001 },
  { k: "0..+25%", lo: 0.0001, hi: 25 },
  { k: "+25..+100%", lo: 25, hi: 100 },
  { k: "+100..+500%", lo: 100, hi: 500 },
  { k: "+500..+2000%", lo: 500, hi: 2000 },
  { k: ">+2000%", lo: 2000, hi: Infinity },
];
const bucketOf = (chg) => BUCKETS.find((b) => chg > b.lo && chg <= b.hi)?.k ?? ">+2000%";

function newAcc() {
  return {
    n: 0, more: 0, less: 0, same: 0,
    todayFee: 0, newFee: 0, todayBurn: 0, newBurn: 0,
    leaderToday: 0, leaderNew: 0,
    changes: [], buckets: Object.fromEntries(BUCKETS.map((b) => [b.k, 0])),
  };
}

function record(acc, todayFee, nf, todayBurn, newBurn, leaderToday, leaderNew) {
  acc.n++;
  acc.todayFee += todayFee; acc.newFee += nf;
  acc.todayBurn += todayBurn; acc.newBurn += newBurn;
  acc.leaderToday += leaderToday; acc.leaderNew += leaderNew;
  const d = nf - todayFee;
  if (d > 0) acc.more++; else if (d < 0) acc.less++; else acc.same++;
  const chg = todayFee > 0 ? (d / todayFee) * 100 : d > 0 ? Infinity : 0;
  acc.buckets[bucketOf(chg)]++;
  if (acc.changes.length < 400_000) acc.changes.push(Number.isFinite(chg) ? chg : 100000);
}

function finish(acc) {
  const s = acc.changes.sort((a, b) => a - b);
  return {
    n: acc.n,
    pctMore: pct(acc.more, acc.n), pctLess: pct(acc.less, acc.n), pctSame: pct(acc.same, acc.n),
    more: acc.more, less: acc.less, same: acc.same,
    avgTodayFee: acc.n ? acc.todayFee / acc.n : 0,
    avgNewFee: acc.n ? acc.newFee / acc.n : 0,
    totalTodayFee: acc.todayFee, totalNewFee: acc.newFee,
    totalTodayBurn: acc.todayBurn, totalNewBurn: acc.newBurn,
    leaderToday: acc.leaderToday, leaderNew: acc.leaderNew,
    p: { p1: percentile(s,1), p5: percentile(s,5), p25: percentile(s,25), p50: percentile(s,50),
         p75: percentile(s,75), p95: percentile(s,95), p99: percentile(s,99) },
    buckets: acc.buckets,
  };
}

// ---- streaming pass ----
const gates = {};
for (const g of GATES) {
  gates[g.key] = {
    all: newAcc(), vote: newAcc(), nonVote: newAcc(), optimized: newAcc(), voteMigrated: newAcc(),
    byProgram: new Map(), byPattern: { neither: newAcc(), cuOnly: newAcc(), loadedOnly: newAcc(), both: newAcc() },
    byCostBucket: new Map(),
  };
}

const COST_BUCKETS = [
  [0, 10_000, "<10k"], [10_000, 25_000, "10-25k"], [25_000, 50_000, "25-50k"],
  [50_000, 100_000, "50-100k"], [100_000, 250_000, "100-250k"],
  [250_000, 500_000, "250-500k"], [500_000, Infinity, ">500k"],
];
const costBucketOf = (cu) => COST_BUCKETS.find(([lo, hi]) => cu >= lo && cu < hi)[2];

let nTx = 0, nVote = 0, nErr = 0, optEligible = 0;
const slotSet = new Set();
let sumRequested = 0, sumConsumed = 0, sumLoadedDefault = 0, sumLoadedActual = 0;
let nSetsCu = 0, nSetsLoaded = 0;

const rl = readline.createInterface({ input: fs.createReadStream(IN), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  let t;
  try { t = JSON.parse(line); } catch { continue; }
  nTx++;
  slotSet.add(t.sl);
  if (t.v) nVote++;
  if (t.e) nErr++;
  if (t.sc) nSetsCu++;
  if (t.sl2) nSetsLoaded++;
  sumRequested += t.cu;
  if (t.cons != null) sumConsumed += t.cons;
  sumLoadedDefault += t.l;
  if (t.al != null) sumLoadedActual += t.al;

  const todayBurn = 2500 * t.s;          // 50% of the signature fee
  const leaderToday = t.f - todayBurn;   // rest of sig fee + all priority
  const pattern = t.sc && t.sl2 ? "both" : t.sc ? "cuOnly" : t.sl2 ? "loadedOnly" : "neither";
  const cb = costBucketOf(t.cu);
  const canOpt = t.cons != null && t.al != null;
  if (canOpt) optEligible++;

  for (const g of GATES) {
    const G = gates[g.key];
    const res = resourceFee(t.cu, g);
    const nf = BASE_INCLUSION_FEE + t.p + res;
    const leaderNew = BASE_INCLUSION_FEE + t.p;

    record(G.all, t.f, nf, todayBurn, res, leaderToday, leaderNew);
    record(t.v ? G.vote : G.nonVote, t.f, nf, todayBurn, res, leaderToday, leaderNew);
    record(G.byPattern[pattern], t.f, nf, todayBurn, res, leaderToday, leaderNew);

    if (!G.byCostBucket.has(cb)) G.byCostBucket.set(cb, newAcc());
    record(G.byCostBucket.get(cb), t.f, nf, todayBurn, res, leaderToday, leaderNew);

    if (!G.byProgram.has(t.pr)) G.byProgram.set(t.pr, newAcc());
    record(G.byProgram.get(t.pr), t.f, nf, todayBurn, res, leaderToday, leaderNew);

    if (t.cuvm != null) {
      const vmRes = resourceFee(t.cuvm, g);
      record(G.voteMigrated, t.f, BASE_INCLUSION_FEE + t.p + vmRes, todayBurn, vmRes,
             leaderToday, leaderNew);
    }

    if (canOpt) {
      // what the tx WOULD cost if it requested accurately:
      // static components unchanged, CU = consumed * headroom, loaded = actual
      const optCu = t.g + t.w + t.d + Math.ceil(Math.max(t.cons, 1) * CU_HEADROOM) + t.al;
      const optRes = resourceFee(optCu, g);
      record(G.optimized, t.f, BASE_INCLUSION_FEE + t.p + optRes, todayBurn, optRes,
             leaderToday, BASE_INCLUSION_FEE + t.p);
    }
  }
}

const nBlocks = slotSet.size;
const txPerBlock = nTx / nBlocks;
const scale = (SLOTS_PER_DAY * txPerBlock) / nTx; // sample-total -> per-day

const out = {
  meta: {
    generatedAt: new Date().toISOString(),
    source: IN,
    blocks: nBlocks,
    transactions: nTx,
    votes: nVote,
    votePct: pct(nVote, nTx),
    failed: nErr,
    txPerBlock,
    slotsPerDay: SLOTS_PER_DAY,
    projectedTxPerDay: SLOTS_PER_DAY * txPerBlock,
    setsCuLimitPct: pct(nSetsCu, nTx),
    setsLoadedSizePct: pct(nSetsLoaded, nTx),
    avgRequestedCostUnits: sumRequested / nTx,
    avgConsumedCu: sumConsumed / nTx,
    loadedDefaultTotal: sumLoadedDefault,
    loadedActualTotal: sumLoadedActual,
    loadedWastePct: pct(sumLoadedDefault - sumLoadedActual, sumLoadedDefault),
    optimizeEligible: optEligible,
    cuHeadroom: CU_HEADROOM,
    assumptions: [
      "requested_cost_units recomputed from agave CostModel::calculate_cost (NOT meta.costUnits, which is the executed cost)",
      "today fee taken from meta.fee (ground truth); priority = meta.fee - 5000*num_signatures",
      "today burn = 50% of signature fee; priority fees 100% to leader (SIMD-0096)",
      "daily projection = measured txs/block * 216000 slots/day",
      "vote program priced at the 3k builtin allocation: feature bls_pubkey_management_in_vote_account (AnAP9zPV4KL7czAPQbFhpDKV2tx7g4UGNbK9wvXwjaRo) is staged but NOT active on mainnet. The voteMigratedScenario block shows what happens when it activates.",
      "optimized scenario = request CU at 1.1x what the tx actually consumed and set loaded-accounts-data-size to the actual bytes loaded (both recovered from chain data)",
    ],
  },
  gates: {},
  programs: {},
};

for (const g of GATES) {
  const G = gates[g.key];
  const all = finish(G.all);
  out.gates[g.key] = {
    label: g.label,
    all,
    vote: finish(G.vote),
    nonVote: finish(G.nonVote),
    optimized: finish(G.optimized),
    voteMigratedScenario: finish(G.voteMigrated),
    byPattern: Object.fromEntries(Object.entries(G.byPattern).map(([k, v]) => [k, finish(v)])),
    byCostBucket: COST_BUCKETS.map(([, , k]) => [k, G.byCostBucket.has(k) ? finish(G.byCostBucket.get(k)) : null])
      .filter(([, v]) => v),
    burn: {
      todayPerDaySol: (all.totalTodayBurn * scale) / LAMPORTS_PER_SOL,
      newPerDaySol: (all.totalNewBurn * scale) / LAMPORTS_PER_SOL,
      multiple: all.totalTodayBurn ? all.totalNewBurn / all.totalTodayBurn : 0,
      optimizedPerDaySol: (finish(G.optimized).totalNewBurn * scale) / LAMPORTS_PER_SOL,
      voteMigratedPerDaySol: (finish(G.voteMigrated).totalNewBurn * scale) / LAMPORTS_PER_SOL,
    },
    leader: {
      todayPerDaySol: (all.leaderToday * scale) / LAMPORTS_PER_SOL,
      newPerDaySol: (all.leaderNew * scale) / LAMPORTS_PER_SOL,
      changePct: all.leaderToday ? ((all.leaderNew - all.leaderToday) / all.leaderToday) * 100 : 0,
    },
  };

  out.programs[g.key] = [...G.byProgram.entries()]
    .map(([id, acc]) => ({ id, label: PROGRAM_LABELS[id] || null, ...finish(acc) }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 40)
    .map((p) => ({
      id: p.id, label: p.label, n: p.n, share: pct(p.n, nTx),
      pctMore: p.pctMore, pctLess: p.pctLess,
      avgTodayFee: p.avgTodayFee, avgNewFee: p.avgNewFee,
      medianChangePct: p.p.p50,
    }));
}

fs.mkdirSync(OUT.split(/[\\/]/).slice(0, -1).join("/") || ".", { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));

const g1 = out.gates.g1_10.all;
console.log(`txs ${nTx} across ${nBlocks} blocks | votes ${out.meta.votePct.toFixed(1)}%`);
console.log(`sets CU limit: ${out.meta.setsCuLimitPct.toFixed(1)}%   sets loaded-size: ${out.meta.setsLoadedSizePct.toFixed(1)}%`);
console.log(`@1/10  more ${g1.pctMore.toFixed(1)}%  less ${g1.pctLess.toFixed(1)}%  median ${g1.p.p50.toFixed(1)}%`);
console.log(`burn/day  today ${out.gates.g1_10.burn.todayPerDaySol.toFixed(0)} SOL -> 1/10 ${out.gates.g1_10.burn.newPerDaySol.toFixed(0)} SOL, 1/2 ${out.gates.g1_2.burn.newPerDaySol.toFixed(0)} SOL`);
console.log(`wrote ${OUT}`);
