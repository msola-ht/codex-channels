import { createLogger } from "../dist/observability/index.js";

// Background diagnostics share Gateway's redaction and constrained Error serializer.
export const webuiLogger = createLogger({ logLevel: "info" }, { service: "webui" });
