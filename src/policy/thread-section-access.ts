import type { SurfaceAccessContext, SurfaceAccessPolicy } from "./surface-access.js";

export class ThreadSectionAccessPolicy implements SurfaceAccessPolicy {
  private readonly administrators: ReadonlySet<string>;

  constructor(administrators: ReadonlySet<string>) {
    this.administrators = new Set(administrators);
  }

  isAllowed(context: SurfaceAccessContext): boolean {
    return this.administrators.has(
      `${context.target.surface}:${context.actorId}`,
    );
  }
}
