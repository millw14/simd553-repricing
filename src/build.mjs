// Inline summary.json into the template and emit two builds:
//
//   web/index.html   artifact FRAGMENT -- no doctype/html/head/body, because the
//                    Artifact platform supplies that skeleton itself.
//   docs/index.html  standalone DOCUMENT for GitHub Pages, with doctype, head,
//                    charset, viewport and social meta.
//
// Same markup and same data; only the wrapper differs.
import fs from "node:fs";

const tpl = fs.readFileSync("web/template.html", "utf8");
const data = fs.readFileSync("web/summary.json", "utf8");
const summary = JSON.parse(data);

// guard against the JSON closing the script tag
const safe = data.replace(/<\//g, "<\\/");
const filled = tpl.replace("__SUMMARY__", safe);

// ---- artifact fragment ----
fs.writeFileSync("web/index.html", filled);

// ---- standalone document ----
// template.html is ordered: <title>/<link>/<style>, then the page, then <script>.
// Split at the page root so the head-ish tags land in a real <head>.
const cut = filled.indexOf('<div class="wrap">');
if (cut < 0) throw new Error("build: could not find page root in template");
const head = filled.slice(0, cut);
const body = filled.slice(cut);

const m = summary.meta;
const desc =
  `SIMD-0553 re-priced against ${m.transactions.toLocaleString("en-US")} real mainnet ` +
  `transactions sampled across epoch ${m.epoch}. Per-program breakdown of what each ` +
  `program is charged for versus what it actually uses.`;
const url = "https://millw14.github.io/simd553-repricing/";
const g = (k) => summary.gates[k].all.pctMore.toFixed(1);
const ogAlt =
  `Share of Solana transactions that would pay more under SIMD-0553: ` +
  `${g("g1_10")}% at the 1/10 gate, ${g("g1_4")}% at 1/4, ${g("g1_2")}% at 1/2.`;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

const doc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${esc(desc)}">
<meta name="color-scheme" content="light dark">
<link rel="canonical" href="${url}">
<meta property="og:type" content="website">
<meta property="og:title" content="SIMD-0553 Repricing Monitor">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${url}og.png">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(ogAlt)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="SIMD-0553 Repricing Monitor">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${url}og.png">
<meta name="twitter:image:alt" content="${esc(ogAlt)}">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>%F0%9F%94%A5</text></svg>">
${head.trim()}
</head>
<body>
${body.trim()}
</body>
</html>
`;

fs.mkdirSync("docs", { recursive: true });
fs.writeFileSync("docs/index.html", doc);
fs.writeFileSync("docs/.nojekyll", "");

console.log(`wrote web/index.html  (${(filled.length / 1024).toFixed(0)} KB, artifact fragment)`);
console.log(`wrote docs/index.html (${(doc.length / 1024).toFixed(0)} KB, standalone for Pages)`);
