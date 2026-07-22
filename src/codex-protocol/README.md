# Codex Protocol

本目录保存当前支持的 Codex App Server 协议类型和精确 CLI 版本基线。

## 文件与目录

- `index.ts`：向业务代码暴露经过审查的最小协议类型集合。
- `version.json`：记录生成类型对应的 `codex-cli` 版本。
- `generated/`：由 `codex app-server generate-ts` 生成的类型，禁止手工修改，也不在其内部维护手写索引文档。

升级协议时执行：

```bash
npm run protocol:generate
npm run protocol:check
npm run check
npm test
```

新增业务依赖的协议类型时，应先审查生成差异，再从 `index.ts` 显式导出；不要跨模块直接导入 `generated/` 内部文件。
