// Minimal Solana JSON-RPC client with retry/backoff, tuned for block scraping.

async function call(url, method, params, tries = 5) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (r.status === 429 || r.status >= 500) {
        await sleep(400 * Math.pow(2, i) + Math.random() * 250);
        continue;
      }
      const j = await r.json();
      if (j.error) {
        // -32009/-32007: slot skipped or ledger-pruned. Caller should move on.
        if (j.error.code === -32009 || j.error.code === -32007) return null;
        throw new Error(`${method}: ${j.error.message}`);
      }
      return j.result;
    } catch (e) {
      lastErr = e;
      await sleep(400 * Math.pow(2, i) + Math.random() * 250);
    }
  }
  throw lastErr || new Error(`${method} failed after ${tries} tries`);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const getSlot = (url) => call(url, "getSlot", [{ commitment: "finalized" }]);

export const getBlock = (url, slot) =>
  call(url, "getBlock", [
    slot,
    {
      encoding: "json",
      transactionDetails: "full",
      rewards: false,
      maxSupportedTransactionVersion: 0,
      commitment: "finalized",
    },
  ]);
