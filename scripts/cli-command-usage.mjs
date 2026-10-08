import { serviceCommandTarget, serviceTargetUsage as internalServiceTargetUsage } from "../runtime/service-targets.mjs";

export const desktopAppCommandUsage = `用法：codexc app [--provider <Provider ID>]
      codexc app enable [--port <端口>]
      codexc app disable
      codexc app status [--provider <Provider ID>] [--json]

  不带子命令             启动 Desktop App；首次使用确认后自动启用共享
  --provider Provider ID  仅本次启动选择已配置的完整 Provider ID；省略时使用主 OpenAI
  enable [--port 端口]   单独启用共享或指定桥端口，并重启 App Server 服务
  disable                禁用共享连接并重启 App Server 服务
  status                 只读检查 Desktop、配置和所选 Provider 连接状态

启动前须完全退出 Desktop；Provider 选择不保存，不修改聊天渠道或原生 TUI 绑定。
日常只需 codexc app。首次启用会重启 App Server，可能中断现有连接与任务；默认不确认。`;

export const timezoneCommandUsage = `用法：codexc timezone [<IANA 时区>|--system] [--json]
      codexc timezone --gateway [<IANA 时区>|--follow-app-server|--system] [--json]

设置 App Server 与 WebUI 服务进程时区，决定模型请求 environment context 里的时区与当前日期，
WebUI 页面时间也随之呈现。缺省不写入配置，两个进程都沿用运行环境的系统时区。

  codexc timezone                    交互选择常见时区，或选“其他”手动输入 IANA 名称；
                                     选中“恢复系统时区”即删除该配置
  codexc timezone Asia/Shanghai      直接写入 [codex].timezone
  codexc timezone --system           删除该配置，恢复系统时区
  codexc timezone --json             只读输出当前配置；
                                     与时区名称或 --system 一起使用时输出写入结果
  codexc timezone --gateway          交互设置网关时区
  codexc timezone --gateway --follow-app-server
                                     网关启动时跟随 codex.timezone，未配置则沿用系统时区
  codexc timezone --gateway Asia/Shanghai
                                     为网关设置独立 IANA 时区
  codexc timezone --gateway --system 写入 gateway.timezone = "system"，使用系统时区

默认入口写入 App Server 与 WebUI 时区配置，未设置独立时区的网关也跟随；不修改系统时区。
修改 App Server 时区后，App Server、Gateway 与 WebUI 均需重启；托管网关自动重启，
直接运行的网关需重新执行原启动命令。--gateway 只设置网关，重启网关后生效；
网关未设置时默认跟随 codex.timezone，--follow-app-server 删除网关独立设置。`;

export const cleanupUsage = `用法：codexc cleanup [sessions|traffic|metrics] [参数]

  sessions <最大轮数> [--idle-days 天数] [--confirm]   预览或归档会话（不删除历史）
  traffic [--dir 目录] [--confirm]                   预览或永久删除请求转储
  metrics [清理参数]                                备份并清理旧指标
  metrics prune <Provider ID>                       备份并清理指定 Provider 指标
  metrics reset                                    备份并重建指标库

交互选择：归档短会话及子会话、删除请求转储、清理旧指标、按 Provider 清理指标或重置指标库。
会话归档、旧指标清理和指标库重置会确认临停 Gateway，结束后按原状态恢复，保留 App Server。
转储删除先预览和确认，再临停 Gateway、Relay 与 App Server，结束后按原状态恢复。
指标清理与重置保留备份；Provider 清理按原状态恢复 Gateway。非受管前台进程仍须自行退出。
无参数时交互终端进入菜单，非交互终端显示帮助。直接命令的停服和确认要求见各子命令 -h；不隐式停止前台进程。`;


export const serviceCommandActions = Object.freeze([
  "install",
  "uninstall",
  "start",
  "stop",
  "reload",
  "status",
  "logs",
]);

const serviceTargetUsage = internalServiceTargetUsage.split("|").map(serviceCommandTarget).join("|");

export const restartCommandUsage = `用法：codexc restart [${serviceTargetUsage}]

默认 all：重启 Gateway、全部 App Server、已安装的 WebUI，以及已安装且启用的 Relay。
预检通过后按 WebUI、Relay、Gateway、App Server 顺序停止，再按相反顺序逐项启动并确认就绪。
未安装的可选服务会跳过；已安装但未启用的 Relay 只停止。单独指定目标时要求已安装。
失败即中止后续步骤，不自动回滚。App Server 与 all 必须在本机终端执行。`;

export const serviceCommandUsage = Object.freeze({
  install: "用法：codexc install\n\n生成全部后台服务定义，并启动 App Server、Gateway 及已安装且启用的 Relay；WebUI 单独启动。",
  uninstall: "用法：codexc uninstall --services",
  start: `用法：codexc start [${serviceTargetUsage}]\n\n默认 all：依次启动 App Server、Gateway、已安装且启用的 Relay、已安装 WebUI，每项确认就绪后再继续。前台运行使用 codexc run。`,
  stop: `用法：codexc stop [${serviceTargetUsage}]\n\n默认 all：依次停止已安装 WebUI、已安装 Relay、Gateway 和 App Server。`,
  reload: "用法：codexc reload\n\n通知 Gateway 重新读取配置。",
  status: `用法：codexc status [${serviceTargetUsage}] [--json]\n\n默认 all：查看 App Server、Gateway、已安装 Relay 与 WebUI。`,
  logs: `用法：codexc logs [${serviceTargetUsage}] [-f|--follow] [-n|--lines 行数]\n\n默认 gateway；all 包含 App Server、Gateway、已安装 Relay 与 WebUI。`,
});
