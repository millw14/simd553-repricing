// Fee math: today vs SIMD-0553.
//
// TODAY   fee = 5000 * num_signatures + priority_fee
//         burn = 50% of the signature fee; priority fee is 100% to the leader
//         (SIMD-0096). We take the total from meta.fee -- ground truth, no model.
//
// SIMD-0553 fee = 2500 (base inclusion, 100% to leader)
//               + priority_fee (unchanged)
//               + ceil_div(requested_cost_units * num, den)   (100% BURNED)

export const BASE_INCLUSION_FEE = 2500;
export const LAMPORTS_PER_SIGNATURE = 5000;

export const GATES = [
  { key: "g1_10", label: "1/10", num: 1n, den: 10n },
  { key: "g1_4", label: "1/4", num: 1n, den: 4n },
  { key: "g1_2", label: "1/2", num: 1n, den: 2n },
];

const ceilDiv = (a, b) => (a + b - 1n) / b;

export function resourceFee(costUnits, gate) {
  return Number(ceilDiv(BigInt(costUnits) * gate.num, gate.den));
}

// Split today's actual fee into its signature and priority components.
export function splitTodayFee(tx) {
  const numSigs = tx.transaction.message.header.numRequiredSignatures;
  const actual = tx.meta?.fee ?? 0;
  const sigFee = LAMPORTS_PER_SIGNATURE * numSigs;
  const priority = Math.max(0, actual - sigFee);
  return { numSigs, actual, sigFee, priority, todayBurn: Math.floor(sigFee / 2) };
}

export function newFee(costUnits, priority, gate) {
  const res = resourceFee(costUnits, gate);
  return { total: BASE_INCLUSION_FEE + priority + res, resource: res, burn: res };
}
