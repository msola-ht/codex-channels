import type { OfficialAccountSnapshot, OfficialAccountSnapshotQueryPort } from "./account-port.js";

/** 统一账户快照查询入口；展示端不得绕过此端口访问 Provider 或数据库。 */
export class OfficialAccountSnapshotService {
  constructor(private readonly query: OfficialAccountSnapshotQueryPort) {}

  latest(provider: string, accountId?: string): Promise<OfficialAccountSnapshot | null> {
    return this.query.latestOfficialAccountSnapshot(provider, accountId);
  }

  latestAll(): Promise<OfficialAccountSnapshot[]> {
    return this.query.latestOfficialAccountSnapshots?.() ?? Promise.resolve([]);
  }
}
