// Downloads the Google Fonts woff2 files and emits web/fonts.css with every face
// embedded as a data: URI, so the published page makes ZERO outbound requests.
//
//   node src/fonts.mjs
//
// Keeps the `latin` and `latin-ext` subsets. latin-ext is NOT optional here: the
// lamport symbol "l with stroke" (U+0142) used throughout the fee columns lives in
// it, and dropping it would silently fall back for every fee figure on the page.

import fs from "node:fs";

// Exactly the faces the rendered page uses -- measured by walking computed styles,
// not guessed. latin-ext is included only where a face actually renders U+0142.
const BOTH = ["latin", "latin-ext"];
const LATIN = ["latin"];
const FAMILIES = [
  { name: "Archivo", faces: { 700: BOTH, 800: LATIN } },      // 700 renders the fee tiles
  { name: "IBM Plex Sans", faces: { 400: BOTH, 600: BOTH } }, // 500/700 unused
  { name: "IBM Plex Mono", faces: { 400: BOTH, 500: BOTH, 600: BOTH } },
];

const wantedSubsets = (fam, wght) => FAMILIES.find((f) => f.name === fam)?.faces[wght];

// A modern browser UA is required, or the API serves ttf instead of woff2.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0.0.0 Safari/537.36";

const spec = FAMILIES.map(
  (f) => `family=${f.name.replace(/ /g, "+")}:wght@${Object.keys(f.faces).join(";")}`
).join("&");
const cssUrl = `https://fonts.googleapis.com/css2?${spec}&display=swap`;

console.log("fetching", cssUrl);
const css = await (await fetch(cssUrl, { headers: { "user-agent": UA } })).text();

// Google emits: /* subset */\n@font-face { ... src: url(...) format('woff2'); }
const blocks = [...css.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/g)];
console.log(`parsed ${blocks.length} @font-face blocks`);

let out = "/* Google Fonts, inlined as data URIs -- no external requests. */\n";
let kept = 0, bytes = 0;

for (const [, subset, block] of blocks) {
  const fam = (block.match(/font-family:\s*'([^']+)'/) || [])[1];
  const wght = (block.match(/font-weight:\s*(\d+)/) || [])[1];
  const allowed = wantedSubsets(fam, wght);
  if (!allowed || !allowed.includes(subset)) continue;

  const url = (block.match(/url\((https:\/\/[^)]+\.woff2)\)/) || [])[1];
  if (!url) continue;

  const buf = Buffer.from(await (await fetch(url, { headers: { "user-agent": UA } })).arrayBuffer());
  bytes += buf.length;
  kept++;

  const style = (block.match(/font-style:\s*(\w+)/) || [])[1] || "normal";
  const range = (block.match(/unicode-range:\s*([^;]+);/) || [])[1];

  out +=
    `@font-face{font-family:'${fam}';font-style:${style};font-weight:${wght};` +
    `font-display:swap;src:url(data:font/woff2;base64,${buf.toString("base64")}) format('woff2');` +
    (range ? `unicode-range:${range};` : "") +
    "}\n";

  console.log(`  ${fam} ${wght} ${subset.padEnd(10)} ${(buf.length / 1024).toFixed(1)} KB`);
}

fs.writeFileSync("web/fonts.css", out);
console.log(
  `\nwrote web/fonts.css -- ${kept} faces, ${(bytes / 1024).toFixed(0)} KB raw, ` +
  `${(out.length / 1024).toFixed(0)} KB base64`
);
