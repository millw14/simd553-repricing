// Faithful JS port of agave CostModel::calculate_cost -- the *requested* /
// pre-execution cost used for block packing. SIMD-0553 charges the resource fee on
// THIS value, NOT on meta.costUnits (which agave populates from
// calculate_cost_for_executed_transaction, i.e. ACTUAL consumed CU + ACTUAL loaded
// data size). Verified line-by-line against agave @ ba508c3ae.

// ---- constants: agave/cost-model/src/block_cost_limits.rs ----
export const COMPUTE_UNIT_TO_US_RATIO = 30;
export const SIGNATURE_COST = COMPUTE_UNIT_TO_US_RATIO * 24; // 720
export const SECP256K1_VERIFY_COST = COMPUTE_UNIT_TO_US_RATIO * 223; // 6690
export const ED25519_VERIFY_STRICT_COST = COMPUTE_UNIT_TO_US_RATIO * 80; // 2400
export const SECP256R1_VERIFY_COST = COMPUTE_UNIT_TO_US_RATIO * 160; // 4800
export const WRITE_LOCK_UNITS = COMPUTE_UNIT_TO_US_RATIO * 10; // 300
// NOTE: integer division in rust -- 140/30 = 4, not 4.67
export const INSTRUCTION_DATA_BYTES_COST = Math.floor(140 / COMPUTE_UNIT_TO_US_RATIO); // 4

// ---- agave/program-runtime/src/execution_budget.rs ----
export const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;
export const DEFAULT_HEAP_COST = 8;
export const DEFAULT_INSTRUCTION_COMPUTE_UNIT_LIMIT = 200_000;
export const MAX_BUILTIN_ALLOCATION_COMPUTE_UNIT_LIMIT = 3_000; // SIMD-170
export const MAX_LOADED_ACCOUNTS_DATA_SIZE_BYTES = 64 * 1024 * 1024;
export const ACCOUNT_DATA_COST_PAGE_SIZE = 32 * 1024;

// Default loaded-accounts-data-size cost when a tx does NOT set the limit:
// 64MiB / 32KiB = 2048 pages * 8 = 16384 cost units. This single term dominates
// the repricing for most of mainnet.
export const DEFAULT_LOADED_COST = 16384;

// ---- program ids ----
export const COMPUTE_BUDGET_ID = "ComputeBudget111111111111111111111111111111";
export const VOTE_ID = "Vote111111111111111111111111111111111111111";
export const SECP256K1_ID = "KeccakSecp256k11111111111111111111111111111";
export const ED25519_ID = "Ed25519SigVerify111111111111111111111111111";
export const SECP256R1_ID = "Secp256r1SigVerify1111111111111111111111111";

// agave/builtins-default-costs/src/lib.rs :: NON_MIGRATING_BUILTINS_COSTS
export const NON_MIGRATING_BUILTINS = new Set([
  "11111111111111111111111111111111", // system
  COMPUTE_BUDGET_ID,
  "BPFLoaderUpgradeab1e11111111111111111111111",
  "BPFLoader1111111111111111111111111111111111", // deprecated
  "BPFLoader2111111111111111111111111111111111",
  "LoaderV411111111111111111111111111111111111",
  SECP256K1_ID,
  ED25519_ID,
]);

// MIGRATING_BUILTINS_COSTS = [vote]. Once its feature gate is active, vote
// instructions fall into the 200k-per-instruction bucket instead of the 3k
// builtin bucket. Only matters for txs that do NOT set an explicit CU limit.
export const MIGRATING_BUILTINS = new Set([VOTE_ID]);

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58MAP = (() => {
  const m = new Int16Array(128).fill(-1);
  for (let i = 0; i < B58.length; i++) m[B58.charCodeAt(i)] = i;
  return m;
})();

// base58 -> Uint8Array. Needed for exact instruction data length and for reading
// ComputeBudget instruction arguments.
export function b58decode(str) {
  const bytes = [0];
  for (let i = 0; i < str.length; i++) {
    const v = B58MAP[str.charCodeAt(i)];
    if (v < 0) throw new Error("bad base58 char");
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // `bytes` is little-endian; strip high-order zero bytes so that "" -> 0 bytes
  // and "1" -> exactly one 0x00 byte. Without this the decoded length is one
  // byte too long for empty/zero data, which shifts data_bytes_cost.
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  let zeros = 0;
  while (zeros < str.length && str[zeros] === "1") zeros++;
  const out = new Uint8Array(zeros + end);
  for (let i = 0; i < end; i++) out[zeros + i] = bytes[end - 1 - i];
  return out;
}

const rdU32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

// agave: calculate_pages_cost(calculate_pages_for_bytes(bytes))
export function loadedAccountsDataSizeCost(bytes) {
  const pages = Math.floor(
    (bytes + ACCOUNT_DATA_COST_PAGE_SIZE - 1) / ACCOUNT_DATA_COST_PAGE_SIZE
  );
  return pages * DEFAULT_HEAP_COST;
}

// Number of write locks = writable static keys + writable ALT-loaded keys.
export function numWriteLocks(tx) {
  const m = tx.transaction.message;
  const h = m.header;
  const nStatic = m.accountKeys.length;
  const writableSigned = h.numRequiredSignatures - h.numReadonlySignedAccounts;
  const writableUnsigned =
    nStatic - h.numRequiredSignatures - h.numReadonlyUnsignedAccounts;
  const loadedWritable = tx.meta?.loadedAddresses?.writable?.length ?? 0;
  return writableSigned + writableUnsigned + loadedWritable;
}

// Mirrors ComputeBudgetInstructionDetails::try_from + sanitize_and_convert.
export function parseBudget(tx, opts) {
  // Default FALSE = mainnet reality as of this writing: feature
  // bls_pubkey_management_in_vote_account (AnAP9zPV4KL7czAPQbFhpDKV2tx7g4UGNbK9wvXwjaRo)
  // is staged but NOT activated, so vote instructions still price at the 3k
  // builtin allocation rather than the 200k non-builtin default.
  const voteMigrated = opts?.voteMigrated ?? false;
  const m = tx.transaction.message;
  const keys = m.accountKeys;
  let requestedCu = null;
  let cuPrice = 0n;
  let requestedLoadedBytes = null;
  let dataBytes = 0;
  let sigSecp256k1 = 0, sigEd25519 = 0, sigSecp256r1 = 0;
  let nBuiltin = 0, nNonBuiltin = 0, nMigrating = 0, nNonCb = 0;
  const programs = [];

  for (const ix of m.instructions) {
    const pid = keys[ix.programIdIndex];
    let data;
    try {
      data = b58decode(ix.data);
    } catch {
      data = new Uint8Array(0);
    }
    dataBytes += data.length;
    programs.push(pid);

    if (pid === COMPUTE_BUDGET_ID) {
      if (data.length >= 1) {
        const tag = data[0];
        // 0=RequestUnitsDeprecated 1=RequestHeapFrame 2=SetComputeUnitLimit
        // 3=SetComputeUnitPrice 4=SetLoadedAccountsDataSizeLimit
        if (tag === 0 && data.length >= 9) requestedCu = rdU32(data, 1);
        else if (tag === 2 && data.length >= 5) requestedCu = rdU32(data, 1);
        else if (tag === 3 && data.length >= 9) {
          let v = 0n;
          for (let i = 8; i >= 1; i--) v = (v << 8n) | BigInt(data[i]);
          cuPrice = v;
        } else if (tag === 4 && data.length >= 5) requestedLoadedBytes = rdU32(data, 1);
      }
    } else {
      nNonCb++;
    }

    // precompile signature counts live in the first byte of instruction data
    if (pid === SECP256K1_ID) sigSecp256k1 += data.length ? data[0] : 0;
    else if (pid === ED25519_ID) sigEd25519 += data.length ? data[0] : 0;
    else if (pid === SECP256R1_ID) sigSecp256r1 += data.length ? data[0] : 0;

    // builtin classification: agave re-iterates ALL instructions, ComputeBudget included
    if (MIGRATING_BUILTINS.has(pid)) nMigrating++;
    else if (NON_MIGRATING_BUILTINS.has(pid)) nBuiltin++;
    else nNonBuiltin++;
  }

  const defaultCu = Math.min(
    (nBuiltin + (voteMigrated ? 0 : nMigrating)) * MAX_BUILTIN_ALLOCATION_COMPUTE_UNIT_LIMIT +
      (nNonBuiltin + (voteMigrated ? nMigrating : 0)) * DEFAULT_INSTRUCTION_COMPUTE_UNIT_LIMIT,
    MAX_COMPUTE_UNIT_LIMIT
  );

  const cuLimit = Math.min(
    requestedCu === null ? defaultCu : requestedCu,
    MAX_COMPUTE_UNIT_LIMIT
  );
  const loadedBytes = Math.min(
    requestedLoadedBytes ?? MAX_LOADED_ACCOUNTS_DATA_SIZE_BYTES,
    MAX_LOADED_ACCOUNTS_DATA_SIZE_BYTES
  );

  return {
    requestedCu, cuPrice, requestedLoadedBytes, cuLimit, loadedBytes, dataBytes,
    sigSecp256k1, sigEd25519, sigSecp256r1, nNonCb, programs,
    setsCuLimit: requestedCu !== null,
    setsLoadedSize: requestedLoadedBytes !== null,
  };
}

// signature_cost per CostModel::get_signature_cost
export function signatureCost(tx, b) {
  const n = tx.transaction.message.header.numRequiredSignatures;
  return (
    n * SIGNATURE_COST +
    b.sigSecp256k1 * SECP256K1_VERIFY_COST +
    b.sigEd25519 * ED25519_VERIFY_STRICT_COST +
    b.sigSecp256r1 * SECP256R1_VERIFY_COST
  );
}

// requested_cost_units -- the SIMD-0553 resource-fee base.
export function requestedCostUnits(tx, opts) {
  const b = parseBudget(tx, opts);
  const sig = signatureCost(tx, b);
  const writeLock = numWriteLocks(tx) * WRITE_LOCK_UNITS;
  const data = Math.floor(b.dataBytes / INSTRUCTION_DATA_BYTES_COST);
  const loaded = loadedAccountsDataSizeCost(b.loadedBytes);
  const total = sig + writeLock + data + b.cuLimit + loaded;
  return { total, sig, writeLock, data, cu: b.cuLimit, loaded, budget: b };
}

// The non-CU part of the cost, used to validate against meta.costUnits:
// meta.costUnits == staticCost + consumedCU + actualLoadedCost
export function staticCost(tx, b) {
  return (
    signatureCost(tx, b) +
    numWriteLocks(tx) * WRITE_LOCK_UNITS +
    Math.floor(b.dataBytes / INSTRUCTION_DATA_BYTES_COST)
  );
}
