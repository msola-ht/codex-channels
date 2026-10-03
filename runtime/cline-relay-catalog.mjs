import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { connectHomePath } from "./connect-home.mjs";
import { readPrivateFileSync } from "./private-file.mjs";

const text = z.string().min(1).max(200).refine(value => value.trim() === value && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value));
const level = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const reasoningOption = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("toggle") }),
  z.strictObject({ type: z.literal("effort"), values: z.array(z.union([level, z.literal("default"), z.null()])).max(9) }),
  z.strictObject({ type: z.literal("budget_tokens"), min: z.number().int().min(-1).optional(), max: z.number().int().nonnegative().optional() }),
]);
export const clineRelayModelSchema = z.object({ id: text, name: text.optional(), contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(), capabilities: z.array(text).max(32).optional(),
  modalities: z.object({ input: z.array(text).max(16), output: z.array(text).max(16) }).optional(),
  reasoningOptions: z.array(reasoningOption).max(3).optional() });
export const clineRelayCatalogSchema = z.strictObject({ version: z.literal(1), commit: z.string().regex(/^[a-f0-9]{40}$/u),
  downloadedAt: z.number().int().positive(), models: z.array(clineRelayModelSchema).min(1).max(256)
    .refine(models => new Set(models.map(model => model.id)).size === models.length) });
export const clineRelayCatalogPath = (environment = process.env) => join(dirname(resolve(environment.CODEX_CONNECT_CONFIG_FILE?.trim() || join(connectHomePath(environment), "config.toml"))), "cline-relay-models.json");

export function readClineRelayCatalog(environment = process.env) {
  let content;
  try { content = readPrivateFileSync(clineRelayCatalogPath(environment), 1024 * 1024); }
  catch (error) { return { status: error?.code === "ENOENT" ? "missing" : "invalid" }; }
  try { const catalog = clineRelayCatalogSchema.parse(JSON.parse(content)); return { status: "ready", catalog, efforts: Object.fromEntries(catalog.models.map(model => [model.id, clineRelayReasoningEfforts(model)])), revision: createHash("sha256").update(content).digest("hex") }; }
  catch { return { status: "invalid" }; }
}

/** Only explicit controls become selectable; missing controls do not imply support. */
export function clineRelayReasoningEfforts(model) {
  const values = new Set();
  for (const option of model.reasoningOptions ?? []) {
    if (option.type === "toggle") values.add("none");
    if (option.type === "effort") for (const value of option.values) if (level.options.includes(value)) values.add(value);
  }
  return level.options.filter(value => values.has(value));
}

/** Cline compacts ordinary language inputs into capabilities; audio stays in modalities. */
export function clineRelayInputModalities(model) {
  if (model.modalities) return model.modalities.input.filter(value => ["text", "image", "audio", "video", "pdf"].includes(value));
  if (!model.capabilities?.length) return [];
  return ["text", ...[["images", "image"], ["video", "video"], ["files", "pdf"]]
    .filter(([capability]) => model.capabilities.includes(capability)).map(([, modality]) => modality)];
}
