export interface QqGroupPairingInput {
  groupOpenId: string;
  memberOpenId: string;
  content: string;
  sentAtMs: number;
}

export interface QqGroupPairingMatch {
  groupOpenId: string;
  memberOpenId: string;
}

export function qqGroupPairingPath(configDirectory: string, appId: string): string;

export class QqGroupPairingServer {
  constructor(configDirectory: string, appId: string);
  start(): Promise<void>;
  accept(input: QqGroupPairingInput): boolean;
  close(): Promise<void>;
}

export function pairQqGroup(options: {
  configDirectory: string;
  appId: string;
  signal?: AbortSignal;
  onCode(code: string): void | Promise<void>;
}): Promise<QqGroupPairingMatch>;
