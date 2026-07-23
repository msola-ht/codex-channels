export class TelegramAccessPolicy {
  private allowedUserIds: ReadonlySet<number>;

  constructor(allowedUserIds: ReadonlySet<number>) {
    this.allowedUserIds = new Set(allowedUserIds);
  }

  replace(allowedUserIds: ReadonlySet<number>): void {
    this.allowedUserIds = new Set(allowedUserIds);
  }

  isAllowed(userId: number | undefined): boolean {
    return userId !== undefined && this.allowedUserIds.has(userId);
  }
}
