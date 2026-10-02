import { DirectChatRequestError } from "../model-api/index.js";

/** CLP-only outbound policy; never mutate the caller's request or fall back to other providers. */
export function pinClinePassRouting<T extends object>(request: T): T {
  const options = routingObject((request as Record<string, unknown>).providerOptions, "providerOptions");
  const gateway = routingObject(options.gateway, "providerOptions.gateway");
  if (Array.isArray(gateway.only) && gateway.only.length === 1 && gateway.only[0] === "deepseek") return request;
  return { ...request, providerOptions: { ...options, gateway: { ...gateway, only: ["deepseek"] } } };
}

function routingObject(value: unknown, path: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DirectChatRequestError(path, "Expected a JSON object");
  }
  return value as Record<string, unknown>;
}
