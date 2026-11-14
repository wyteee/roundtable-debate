// 本地预览：静态托管 dist/ + 用假 LLM 跑 /api/debate，不需要任何 API key。
// 用法：npm run build && MOCK_SCENARIO=settled node scripts/serve-mock.mjs   → http://localhost:4173
// MOCK_LATENCY_MS 模拟每次模型调用的耗时（默认 1500ms），用来检查"边读边预取"是否把等待藏住了。

import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.MOCK_LLM = "1";
const { default: handler } = await import("../api/debate.js");

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const latency = Number(process.env.MOCK_LATENCY_MS ?? 1500);
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".svg": "image/svg+xml" };

http
  .createServer(async (req, res) => {
    if (req.url.startsWith("/api/debate")) {
      let body = "";
      for await (const chunk of req) body += chunk;
      const parsed = body ? JSON.parse(body) : {};
      // 粗略模拟：开场/收尾并行≈1 次调用，交锋轮顺序≈3 次调用
      const calls = parsed.phase === "debate" && parsed.round > 0 ? 3 : 1;
      await new Promise((r) => setTimeout(r, latency * calls));
      const shim = {
        status(c) {
          res.statusCode = c;
          return shim;
        },
        json(d) {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(d));
        },
      };
      return handler({ method: req.method, body: parsed }, shim);
    }
    const p = req.url.split("?")[0];
    const file = path.join(root, p === "/" ? "index.html" : decodeURIComponent(p));
    try {
      const data = await readFile(file);
      res.setHeader("content-type", types[path.extname(file)] || "application/octet-stream");
      res.end(data);
    } catch {
      res.end(await readFile(path.join(root, "index.html")));
    }
  })
  .listen(4173, () => console.log("mock preview on http://localhost:4173"));
