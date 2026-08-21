// Tiny static server for web/ -- no dependencies.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.PORT || 4553);
// Serve the project root so both builds are reachable:
//   /            -> web/index.html   (artifact fragment)
//   /docs/       -> docs/index.html  (standalone document, what Pages serves)
const ROOT = path.resolve(import.meta.dirname);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

// Fixed-target upload used by web/og.html to write the generated card straight to
// disk, so the image bytes never have to travel through anything else.
const SAVE_TARGETS = { "/_save/og.png": "docs/og.png" };

http
  .createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]);

    if (req.method === "POST" && SAVE_TARGETS[rel]) {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const buf = Buffer.concat(chunks);
        const dest = path.join(ROOT, SAVE_TARGETS[rel]);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, buf);
        console.log(`saved ${SAVE_TARGETS[rel]} (${buf.length} bytes)`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, bytes: buf.length }));
      });
      return;
    }
    const target = rel === "/" ? "web/index.html" : rel.endsWith("/") ? rel + "index.html" : rel;
    const file = path.join(ROOT, target);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end("forbidden"); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end("not found"); return; }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
      res.end(buf);
    });
  })
  .listen(PORT, () => console.log(`simd553 dashboard on http://localhost:${PORT}`));
