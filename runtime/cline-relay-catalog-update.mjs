import { request } from "node:https";
import { z } from "zod";
import { HttpsProxyAgent } from "https-proxy-agent";
import { readPrivateFileSync, writePrivateFileAtomicSync } from "./private-file.mjs";
import { readCodexProxySettings } from "./codex-proxy-env.mjs";
import { createRefreshableHttpProxySelector } from "./network-proxy.mjs";

const maximumBytes = 16 * 1024 * 1024;
import { clineRelayCatalogPath, readClineRelayCatalog, clineRelayCatalogSchema as schema, clineRelayModelSchema as modelSchema } from "./cline-relay-catalog.mjs";
export { clineRelayCatalogPath, readClineRelayCatalog, clineRelayReasoningEfforts } from "./cline-relay-catalog.mjs";

/** Parse JSON data inside the upstream generated TS file. Never evaluate upstream code. */
export function parseClineRelayCatalog(source, commit, downloadedAt = Date.now()) {
  const match = /\n {2}providers: (\{[\s\S]*\})\s*\n\}\s*;?\s*$/u.exec(source);
  if (!match || Buffer.byteLength(source) > maximumBytes) throw new Error("Cline 模型文件格式无效");
  const providers = JSON.parse(match[1]);
  const entries = providers["cline-pass"];
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new Error("Cline Pass 目录缺失");
  const models = Object.entries(entries).filter(([id]) => id.startsWith("cline-pass/")).map(([id, model]) => {
    if (model?.id !== id) throw new Error("Cline 模型标识不一致");
    return modelSchema.parse(model);
  });
  return schema.parse({ version: 1, commit, downloadedAt, models });
}

async function download(url, selector, signal) {
  const proxy = await selector.select(new URL(url));
  signal.throwIfAborted();
  const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
  try {
    return await new Promise((resolve, reject) => {
      const req = request(url, { agent, signal, headers: { "User-Agent": "codexc-cline-catalog", Accept: "application/json" } }, response => {
        if (response.statusCode !== 200) { response.destroy(); reject(new Error("Cline 目录下载失败")); return; }
        let length = 0; const chunks = [];
        response.on("data", chunk => {
          length += chunk.length;
          if (length > maximumBytes) { response.destroy(new Error("Cline 目录超过大小限制")); return; }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });
      req.on("error", reject); req.end();
    });
  } finally { agent?.destroy(); }
}

/** Public metadata only: fixed origins, pinned commit, no account credentials or redirects. */
export async function downloadClineRelayCatalog(environment = process.env, signal = globalThis.AbortSignal.timeout(25_000)) {
  const selector = createRefreshableHttpProxySelector(readCodexProxySettings(environment), environment);
  try {
    const info = JSON.parse(await download("https://api.github.com/repos/cline/cline/commits/main", selector, signal));
    const commit = z.string().regex(/^[a-f0-9]{40}$/u).parse(info.sha);
    const source = await download(`https://raw.githubusercontent.com/cline/cline/${commit}/sdk/packages/llms/src/catalog/catalog.generated.ts`, selector, signal);
    return parseClineRelayCatalog(source, commit);
  } finally { await selector.close(); }
}

/** Caller owns the management transaction. The previous complete file remains recoverable. */
export function saveClineRelayCatalog(catalog, environment = process.env) {
  const content = JSON.stringify(schema.parse(catalog), null, 2) + "\n";
  if (Buffer.byteLength(content) > 1024 * 1024) throw new Error("Cline 目录超过大小限制");
  const path = clineRelayCatalogPath(environment);
  let previous;
  try { previous = readPrivateFileSync(path, 1024 * 1024); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (previous !== undefined) {
    writePrivateFileAtomicSync(`${path}.backup`, previous);
    if (readPrivateFileSync(`${path}.backup`, 1024 * 1024) !== previous) throw new Error("Cline 目录备份校验失败");
  }
  writePrivateFileAtomicSync(path, content);
  return readClineRelayCatalog(environment);
}
