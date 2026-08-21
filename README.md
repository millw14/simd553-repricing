# SIMD-0553 Repricing Monitor

Re-prices real mainnet traffic under [SIMD-0553](https://github.com/solana-foundation/solana-improvement-documents/blob/main/proposals/0553-resource-fee-burn.md)
(Base Inclusion and Resource Fee) and reports what share of existing transactions
would pay more, less, or the same at each feature gate.

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
**100.000% of transactions** (`node src/validate.mjs 5`). That pins the three
static components exactly; the remaining two are read directly out of the
transaction's ComputeBudget instructions.

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

## Run it

```bash
node src/validate.mjs 5                                   # prove the model
node src/ingest.mjs --blocks 260 --stride 40 --conc 3      # scrape -> data/txs.jsonl
node src/aggregate.mjs --in data/txs.jsonl --out web/summary.json
node src/build.mjs                                         # -> web/index.html
node server.mjs                                            # http://localhost:4553
```

`RPC_URL` overrides the endpoint; the public one works but is slow. Larger
`--blocks` and smaller `--stride` trade runtime for sample size.

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

- One ~1.7-hour window of mainnet, not a full epoch. Traffic mix moves; re-run for
  a different sample.
- Daily projections scale measured txs/block by 216,000 slots/day.
- Today's fee comes from `meta.fee` (ground truth); priority is derived as
  `meta.fee - 5000 * num_signatures`.
- The "requested accurately" scenario assumes 1.1× consumed CU and the true loaded
  size, both recovered from chain data — a floor on what optimisation could achieve,
  since no real sender can predict consumption exactly.
