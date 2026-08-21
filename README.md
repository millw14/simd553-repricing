# SIMD-0553 Repricing Monitor

**Live dashboard → https://millw14.github.io/simd553-repricing/**

Re-prices real mainnet traffic under [SIMD-0553](https://github.com/solana-foundation/solana-improvement-documents/blob/main/proposals/0553-resource-fee-burn.md)
(Base Inclusion and Resource Fee) and reports what share of existing transactions
would pay more, less, or the same at each feature gate.

Current run: **6,065,467 transactions** sampled across all of **epoch 1018**.
Every number on the dashboard is recomputed from block data — no estimates.

```
total_fee = 2500                                      (base inclusion, 100% to leader)
          + priority_fee                              (unchanged)
          + ceil_div(requested_cost_units * n, d)     (resource fee, 100% burned)

gates:  1/10  ->  1/4  ->  1/2
```

## The thing that makes this hard

`meta.costUnits` in the RPC response is **not** the number SIMD-0553 charges on.

agave has two cost functions. `CostModel::calculate_cost` computes the
**requested** cost from the transaction's declared compute-unit limit and declared
loaded-accounts-data-size — this is what the scheduler uses for block packing, and
what the SIMD prices. `CostModel::calculate_cost_for_executed_transaction`
recomputes it after execution with **actual** consumed CU and **actual** loaded
bytes — and that is what lands in `meta.costUnits`.

Building this analysis off `meta.costUnits` understates the fee on precisely the
transactions the proposal is aimed at: the ones that over-request. So
`src/costModel.mjs` is a line-by-line port of `calculate_cost`.

## Correctness

The port is validated against agave's own accounting rather than trusted.

Since `meta.costUnits = signature + write_lock + data_bytes + consumedCU + actualLoadedCost`,
and the loaded-accounts cost is always `pages * 8`, the residual

```
meta.costUnits - (signature + write_lock + data_bytes) - computeUnitsConsumed
```

must be a non-negative multiple of 8 for every transaction. It is, for
**100.000% of transactions** (`node src/validate.mjs 5`) — and the full epoch scrape
reported **0 mismatches across 6,065,467 transactions**. That pins the three static
components exactly; the remaining two are read directly out of the transaction's
ComputeBudget instructions.

As an independent cross-check, the model reproduces Cavey's published vote-transaction
figure (~4,383 lamports at the terminal rate for a vote that declares a tight compute
budget) to within rounding.

Constants and logic verified against agave `ba508c3ae`:

| value | source |
|---|---|
| `SIGNATURE_COST` 720, `WRITE_LOCK_UNITS` 300 | `cost-model/src/block_cost_limits.rs` |
| `INSTRUCTION_DATA_BYTES_COST` = 140/30 = **4** (integer division) | same |
| loaded cost = `ceil(bytes / 32KiB) * 8`, default 64MiB → **16,384** | `cost_model.rs`, `execution_budget.rs` |
| default CU = builtins×**3,000** + non-builtins×**200,000**, capped 1.4M | `compute-budget-instruction/src/compute_budget_instruction_details.rs` |

That last row matters: a builtin instruction defaults to 3,000 CU, not 200,000.

## Vote transactions

`bls_pubkey_management_in_vote_account`
(`AnAP9zPV4KL7czAPQbFhpDKV2tx7g4UGNbK9wvXwjaRo`) is **staged but not active** on
mainnet — checked on chain, not assumed. So vote instructions price at the 3,000
builtin allocation. When it activates they move to the 200,000 default, which is
modelled as a separate scenario in the dashboard.

In the sample, **0% of vote transactions set any compute budget**, so Cavey's
"Vote (with ComputeBudget)" example describes a future state, not current traffic.

## Per-program drilldown

The dashboard carries a searchable record for the top 150 programs by transaction
count. Selecting one shows two bars on the same scale — what its average transaction
is **charged for** versus what it **actually uses** — broken into signature, write
locks, instruction data, requested CU, and loaded-accounts size.

The gap is the actionable part. pump.fun, for example, leaves **87%** of the compute
it requests unused and takes the loaded-accounts default on 29% of its transactions.
At the 1/10 gate that is a median **+104%**; requesting accurately would make it
**−31%**.

Consumed CU comes from `meta.computeUnitsConsumed`; the actual loaded-accounts cost is
recovered from the `meta.costUnits` residual, so both sides of the comparison are
measured, not assumed.

## Sampling

Scraping all 432,000 slots of an epoch is not practical, so the ingester takes a
stratified sample across the epoch's full slot range. Two details matter:

**The stride must be odd.** The leader schedule gives each leader 4 consecutive
slots. Any stride that is a multiple of 4 samples the same position in every
leader's window — always the handoff slot, say — which aliases with leader rotation
and biases the mix. `ingest.mjs` refuses an even stride.

**Percentiles use a seeded reservoir sample.** Retaining "the first N" changes per
accumulator would make every percentile describe only the opening hours of the
epoch. Algorithm R with a fixed-seed PRNG keeps the retained sample uniform over the
whole span and reproducible across runs. Counts, sums and histogram buckets are exact
— only percentiles are sampled.

Coverage is reported rather than assumed: slots where the leader produced no block
are counted separately from slots the RPC failed to return, and the latter are
surfaced as a warning, since RPC failures cluster under throttling and are not
random. The daily projection uses the measured block-production rate, not an
assumption that every slot yields a block.

## Run it

```bash
node src/validate.mjs 5                       # prove the model against mainnet
node src/ingest.mjs --from <startSlot> --to <endSlot> \
     --blocks 4000 --stride 107 --conc 12 --out data/epoch.jsonl
node src/aggregate.mjs --in data/epoch.jsonl --out web/summary.json
node src/build.mjs                            # -> self-contained web/index.html
node server.mjs                               # http://localhost:4553
```

Put `RPC_URL=https://…` in `simd553/.env` (gitignored, never logged in full — only
the host is printed) or pass it in the environment. The public endpoint is archival
and works, at roughly a fifth of the throughput of a keyed provider.

Omit `--from`/`--to` to sample backwards from the tip instead. Get an epoch's slot
range from `getEpochInfo`: `epochStart = absoluteSlot - slotIndex`, and the previous
(complete) epoch is the 432,000 slots below that.

## Layout

```
src/costModel.mjs   port of CostModel::calculate_cost + base58 decode
src/fees.mjs        today-vs-0553 fee math
src/validate.mjs    correctness harness against meta.costUnits
src/ingest.mjs      block scraper -> JSONL
src/aggregate.mjs   JSONL -> summary.json
src/build.mjs       inline summary into a self-contained page
web/template.html   dashboard
```

## Caveats

- The published run samples **epoch 1018** (slots 439,776,000–440,203,893, 47.5 h):
  every 107th slot, 3,997 of 4,000 blocks returned, 6,065,467 transactions, 0 RPC
  failures. It is a sample of the epoch, not every block in it.
- Traffic mix still moves between epochs. Going from a 1.7 h window to the full epoch
  left the medians unchanged but moved "pays more" at the 1/2 gate from 87.6% to
  93.7%, and the non-vote median from +629% to +749% — small windows understate how
  much non-vote traffic reprices.
- Daily projections scale measured txs/block by 216,000 slots/day and the measured
  block-production rate.
- Today's fee comes from `meta.fee` (ground truth); priority is derived as
  `meta.fee - 5000 * num_signatures`.
- The "requested accurately" scenario assumes 1.1× consumed CU and the true loaded
  size, both recovered from chain data — a floor on what optimisation could achieve,
  since no real sender can predict consumption exactly.
