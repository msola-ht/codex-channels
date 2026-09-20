# 模型可见时区

本文说明模型请求里 `environment context` 的时区与日期从哪里来，以及如何在不修改系统时区的前提下
调整它。对应配置字段 `[codex].timezone`、`[gateway].timezone`，公开命令 `codexc timezone`。

## 当前行为

App Server 在每轮构造请求时读取进程时区，把时区名与当天日期写入 environment context，作为
Responses 请求 `input` 的一部分发给模型：

```text
<environment_context>
  <current_date>2026-09-19</current_date>
  <timezone>Asia/Shanghai</timezone>
</environment_context>
```

- 时区名来自 `iana_time_zone`，日期来自本地时间（[`turn_context.rs`](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/core/src/session/turn_context.rs)）。
- 它是 prompt 内容，不是协议字段：请求头、`client_metadata`、时间戳都不含时区。
- 未配置 `[codex].timezone` 时，App Server 子进程继承服务环境的时区，即系统时区。

## 配置

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `codex.timezone` | 不设置 | App Server 子进程与 WebUI 服务进程的 IANA 时区名称（如 `America/Los_Angeles`、`Asia/Shanghai`、`Etc/GMT+8`） |
| `gateway.timezone` | 不设置，跟随 `codex.timezone` | `system` 表示独立使用系统时区，或填写 Node.js 支持的 IANA 时区名称 |

`codex.timezone` 用于 App Server 与 WebUI；网关未配置独立时区时也跟随此值，不修改系统时区。
通过 `codexc timezone` 写入时会在边界校验 IANA 名称格式与系统时区库存在性，避免系统
解析失败后静默回退到 UTC；运行环境没有系统时区库时只校验名称格式。直接编辑配置文件只做格式
校验，名称是否被平台识别由平台解析决定。

## 命令

```bash
codexc timezone                    # 交互选择常见时区，或用「其他」手动输入 IANA 名称
codexc timezone America/Los_Angeles # 直接写入，不进入交互
codexc timezone --system           # 删除配置，恢复系统时区
codexc timezone --json             # 只读输出当前配置
```

交互列表只有常见时区（含上海、东京、伦敦、纽约、洛杉矶和 UTC）加两个动作项：「恢复系统时区」
删除 `codex.timezone`，「其他」要求手动输入 IANA 名称。已配置的值默认高亮，因此直接回车不会
改变配置；不在常见列表里的当前值会单独列在「当前配置」下。

同一入口也位于 `codexc config` → 系统设置 → 模型可见时区。

## 网关时区

使用 `codexc config` → 系统设置 → 网关时区，或 `codexc timezone --gateway`，选择：

- **跟随 App Server（默认）**：删除 `gateway.timezone`，启动时使用 `codex.timezone`；App Server
  未配置时继承网关运行环境的系统时区。这是跟随配置，不是查询 App Server 进程的实际时区。
- **系统时区**：写入 `gateway.timezone = "system"`，独立使用网关运行环境的系统时区。
- **其他时区**：选择常见时区或手动填写 IANA 名称，写入 `gateway.timezone`。

```bash
codexc timezone --gateway --follow-app-server # 删除独立设置，恢复默认跟随
codexc timezone --gateway --system            # 独立使用系统时区
codexc timezone --gateway Asia/Shanghai       # 自定义时区
codexc timezone --gateway --json              # 只读查看网关时区设置
codexc service restart gateway               # 重启后生效
```

网关在创建应用组件前应用解析后的时区，启动卡“网关时区”显示实际采用的时区。无效或 Node.js
不支持的时区会明确报错，包括默认跟随的 `codex.timezone`。已保存的无效网关时区仍可通过设置命令
或菜单替换；新值写入和网关启动时继续严格校验。网关配置监听发现有效网关时区或 `codex.timezone`
变化时按现有流程退出，由监管入口重启，并刷新三个渠道的启动卡配置；直接运行时需手动重新启动。
网关时区设置不修改 App Server 或 WebUI。

## 生效与影响

- 修改或清除 App Server 时区后，App Server、Gateway 与 WebUI 均需重启，命令返回三项生效范围。
  托管网关通过配置监听自动重启；直接运行的网关需重新执行原启动命令，例如 `npm run dev` 或 `npm start`。
- 系统时区不受影响；Gateway 默认跟随 App Server 时区配置，也可独立设置。请求转储与指标数据库仍记录绝对时间戳。
- WebUI 的 `/api/v1/time` 返回该时区，页面时间展示与按天、按小时的指标分组随之变化。
- App Server 派生的工具子进程继承该时区，模型执行 `date` 等命令看到的时间与它收到的时区一致。
- macOS 与 Windows 的时区名与日期都由 `TZ` 决定；Linux 上的时区名来自 `/etc/localtime`
  （`iana_time_zone` 不读 `TZ`），因此该平台只改变日期，上报的时区名仍按系统时区。
- 原生 TUI 的本地显示仍使用系统时区，可能与模型看到的日期相差一天。
- 只改变“声明的时区”，不改变请求真实发生的时间；长期作息与声明时区不一致时，活跃时间模式仍
  可能体现真实位置。

## 验证

- `tests/config-management.test.ts`：`system.app-server-timezone` 的写入与清除。
- `tests/timezone-command.test.ts`：`codexc timezone` 的参数校验、写入、清除与非交互输出。
- `tests/app-server-service-runtime.test.ts`：App Server 子进程环境只在配置后带上 `TZ`。
- `tests/webui-server-access.test.ts`：WebUI 服务进程只在配置后把 `TZ` 改为配置值。
- `tests/codexc-cli-syntax.test.ts`：`codexc timezone --help` 的公开帮助入口。
