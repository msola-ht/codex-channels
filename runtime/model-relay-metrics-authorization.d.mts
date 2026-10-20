import type { RelayMetric, RelayMetricRejection } from "../dist/provider-proxy/index.js";
export interface RelayMetricAuthorization {
  (sample: RelayMetric, signal?: AbortSignal): Promise<RelayMetricRejection | undefined>;
  prepare(): Promise<void>;
  close(): Promise<void>;
}
export function createRelayMetricAuthorization(configPath: string, environment?: NodeJS.ProcessEnv): RelayMetricAuthorization;
