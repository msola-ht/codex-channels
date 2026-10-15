import { realpathSync, statSync } from "node:fs";

/** Inspect without modifying the directory or hiding filesystem failure categories. */
export function inspectWorkspaceDirectory(cwd) {
  try {
    const resolved = realpathSync(cwd);
    return statSync(resolved).isDirectory()
      ? { valid: true, status: "available", cwd: resolved }
      : { valid: false, status: "not-directory", detail: "路径不是目录" };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { valid: false, status: "missing", detail: "路径不存在（也可能是磁盘未挂载或符号链接目标不存在）" };
    }
    if (error?.code === "ENOTDIR") {
      return { valid: false, status: "not-directory", detail: "路径中的某一级不是目录" };
    }
    return { valid: false, status: "inaccessible", detail: "目录无法访问，请检查权限和文件系统状态" };
  }
}
