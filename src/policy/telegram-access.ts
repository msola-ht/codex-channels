export class TelegramAccessPolicy {
  constructor(private readonly allowedUserIds: ReadonlySet<number>) {}

  isAllowed(userId: number | undefined): boolean {
    return userId !== undefined && this.allowedUserIds.has(userId);
  }
}
