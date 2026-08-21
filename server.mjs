// Tiny static server for web/ -- no dependencies.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.PORT || 4553);
// resolve relative to this file so it works from any cwd
const ROOT = path.resolve(import.meta.dirname, "web");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

http
  .createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]);
    const file = path.join(ROOT, rel === "/" ? "index.html" : rel);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end("forbidden"); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end("not found"); return; }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
      res.end(buf);
    });
  })
  .listen(PORT, () => console.log(`simd553 dashboard on http://localhost:${PORT}`));
