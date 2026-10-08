export class ClinePassModelGuard {
  constructor(path: string);
  isEnabled(model: string, signal?: AbortSignal): Promise<boolean>;
  close(): Promise<void>;
}
