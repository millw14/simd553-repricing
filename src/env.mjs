// Loads RPC_URL from simd553/.env if it is not already in the environment.
// The .env file is gitignored -- the key must never reach a commit or the built page.
import fs from "node:fs";
import path from "node:path";

const file = path.resolve(import.meta.dirname, "..", ".env");
if (!process.env.RPC_URL && fs.existsSync(file)) {
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

// Never log a full endpoint -- providers put the API key in the query string.
export const redact = (url) => {
  try {
    const u = new URL(url);
    return u.host + (u.searchParams.has("api-key") ? " (keyed)" : "");
  } catch {
    return "invalid-url";
  }
};
