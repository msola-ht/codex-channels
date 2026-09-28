import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolveOptionalExecutable } from "../runtime/executable.mjs";

/** Installation-only OS prerequisites; never changes Codex permission settings. */
export function ensureSandboxDependencies({
  platform = process.platform,
  uid = process.getuid?.(),
  resolve = resolveOptionalExecutable,
  run = (file, args, options) => spawnSync(file, args, options),
  log = console.log,
} = {}) {
  if (platform === "darwin") {
    if (!resolve("/usr/bin/sandbox-exec")) throw new Error("macOS 缺少系统 sandbox-exec，请修复系统组件后重试；无需安装 bubblewrap");
    log("macOS 系统沙盒入口已就绪，无需安装 bubblewrap。");
    return;
  }
  if (platform !== "linux") return;
  let binary = resolve("bwrap");
  if (!binary) {
    const apt = resolve("apt-get");
    const dnf = apt ? undefined : resolve("dnf");
    const manager = apt ?? dnf;
    const guidance = "请先安装 bubblewrap 并确认 bwrap 在 PATH 中（Debian/Ubuntu：sudo apt-get install bubblewrap；Fedora/RHEL：sudo dnf install bubblewrap），然后重试安装";
    if (!manager) throw new Error(`未找到受支持的系统包管理器；${guidance}`);
    const sudo = uid === 0 ? undefined : resolve("sudo");
    if (uid !== 0 && !sudo) throw new Error(`当前用户无法安装沙盒依赖；${guidance}`);
    log("Linux 缺少系统 bwrap，正在安装 bubblewrap；不修改沙盒权限或内核设置。");
    const args = ["install", "-y", "bubblewrap"];
    const result = run(sudo ?? manager, sudo ? ["-n", manager, ...args] : args, { stdio: "inherit" });
    if (result.error || result.status !== 0) throw new Error(`bubblewrap 安装失败或需要管理员授权；${guidance}`);
    binary = resolve("bwrap");
    if (!binary) throw new Error(`安装后仍找不到 bwrap；${guidance}`);
  }
  // The locked Codex launcher requires --perms; mere PATH presence is insufficient.
  const probe = run(binary, ["--help"], { encoding: "utf8", timeout: 5_000 });
  if (probe.error || probe.status !== 0 || !String(probe.stdout).includes("--perms")) {
    throw new Error("系统 bwrap 无法执行或缺少 Codex 所需的 --perms，请更新 bubblewrap 后重试安装");
  }
  log("Linux bubblewrap 依赖检查通过；实际沙盒可用性仍受内核、容器和系统安全策略约束。");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) throw new Error("sandbox-dependencies.mjs 不接受参数");
  ensureSandboxDependencies();
}
