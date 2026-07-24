# Config

本目录负责把共享运行时已完成结构校验的 TOML 文档转换为 Gateway 运行配置。

## 文件

- `index.ts`：读取统一 TOML 配置，调用 `runtime/gateway-config.mjs` 的共享 Zod Schema 完成结构校验，再校验 Workspace 和 URL 等运行语义、合并自动发现的有效代理，并相对配置目录规范化路径。
- `config-change.ts`：定义结构化配置变更、作用域与优先级。

配置结构只在共享运行时边界验证一次，本目录只补充依赖文件系统和运行语义的校验。配置错误必须抛出 `ConfigurationError` 并阻止启动，不能静默采用更宽松的权限、目录或网络默认值。
