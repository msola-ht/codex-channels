export interface CodexTransport {
  readonly kind: "unix-websocket" | "stdio";
  connect(): Promise<void>;
  close(): Promise<void>;
  send(message: string): Promise<void>;
  onMessage(handler: (message: string) => void): () => void;
  onClose(handler: (error?: Error) => void): () => void;
}

export abstract class BaseTransport implements CodexTransport {
  abstract readonly kind: "unix-websocket" | "stdio";
  private readonly messageHandlers = new Set<(message: string) => void>();
  private readonly closeHandlers = new Set<(error?: Error) => void>();

  abstract connect(): Promise<void>;
  abstract close(): Promise<void>;
  abstract send(message: string): Promise<void>;

  onMessage(handler: (message: string) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onClose(handler: (error?: Error) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  protected emitMessage(message: string): void {
    for (const handler of this.messageHandlers) {
      handler(message);
    }
  }

  protected emitClose(error?: Error): void {
    for (const handler of this.closeHandlers) {
      handler(error);
    }
  }
}
