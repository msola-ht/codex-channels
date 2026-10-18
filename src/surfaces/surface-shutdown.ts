/** Collect failures without changing each Surface's resource ordering or budgets. */
export class SurfaceShutdown {
  private readonly failures: Error[] = [];

  async run(resource: string, close: () => unknown): Promise<void> {
    try {
      await close();
    } catch (cause) {
      this.failures.push(new Error(`Surface 关闭失败：${resource}`, { cause }));
    }
  }

  finish(): void {
    if (this.failures.length > 0) {
      throw new AggregateError(this.failures, "Surface 部分资源未确认关闭");
    }
  }
}
