export interface TrafficDumpManifest {
  createdAtMs: number;
  label: string;
  session: string;
  version: number;
}

export function projectTrafficDumpManifest(value: unknown): TrafficDumpManifest | undefined;
