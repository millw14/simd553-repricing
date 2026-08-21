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

http
  .createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]);
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
