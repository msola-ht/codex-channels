# 模型可见时区

本文说明模型请求里 `environment context` 的时区与日期从哪里来，以及如何在不修改系统时区的前提下
调整它。对应配置字段 `[codex].timezone`、公开命令 `codexc timezone`。

## 当前行为

App Server 在每轮构造请求时读取进程时区，把时区名与当天日期写入 environment context，作为
Responses 请求 `input` 的一部分发给模型：

```text
<environment_context>
  <current_date>2026-09-19</current_date>
  <timezone>Asia/Shanghai</timezone>
</environment_context>
```

- 时区名来自 `iana_time_zone`，日期来自本地时间（[`turn_context.rs`](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/session/turn_context.rs)）。
- 它是 prompt 内容，不是协议字段：请求头、`client_metadata`、时间戳都不含时区。
- 未配置 `[codex].timezone` 时，App Server 子进程继承服务环境的时区，即系统时区。

## 配置

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `codex.timezone` | 不设置 | App Server 子进程与 WebUI 服务进程的 IANA 时区名称（如 `America/Los_Angeles`、`Asia/Shanghai`、`Etc/GMT+8`） |

该值只写入 App Server 子进程与 WebUI 服务进程环境，不修改系统时区，也不写入服务定义以外的
其他进程。通过 `codexc timezone` 写入时会在边界校验 IANA 名称格式与系统时区库存在性，避免系统
解析失败后静默回退到 UTC；运行环境没有系统时区库时只校验名称格式。直接编辑配置文件只做格式
校验，名称是否被平台识别由平台解析决定。

## 命令

```bash
codexc timezone                    # 交互设置，预填当前值，留空即恢复系统时区
codexc timezone America/Los_Angeles
codexc timezone --system           # 删除配置，恢复系统时区
codexc timezone --json             # 只读输出当前配置
```

同一入口也位于 `codexc config` → 系统设置 → 模型可见时区。

## 生效与影响

- 配置随 App Server 与 WebUI 服务进程启动生效，命令会提示分别重启两者。
- 系统时区与 Gateway 进程不受影响；请求转储与指标数据库仍记录绝对时间戳。
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
