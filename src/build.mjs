// Inline summary.json into the template -> a self-contained web/index.html
import fs from "node:fs";

const tpl = fs.readFileSync("web/template.html", "utf8");
const data = fs.readFileSync("web/summary.json", "utf8");

// guard against the JSON closing the script tag
const safe = data.replace(/<\//g, "<\\/");
const html = tpl.replace("__SUMMARY__", safe);

fs.writeFileSync("web/index.html", html);
console.log(`wrote web/index.html (${(html.length / 1024).toFixed(0)} KB)`);
