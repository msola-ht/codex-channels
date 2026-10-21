# DeepSeek 图片上传关联修复

历史记录：修复、隔离观察及独立复查已完成，2026-10-21。审查和行为证据对应基线 `main` 的 `ac0841c365b974d81a2c6239f502aa9c0f5ad633` 及分支 `fix/deepseek-upload-boundary` 的本批修复；最终交付提交由该分支 PR 标识。用户授权提交推送并创建 PR；未部署、未合并本修复 PR、未访问真实账户或进行付费调用。此前 #277 保持未合并。当前合同见 [DeepSeek 图片识别](../deepseek.md#图片识别)及对应模块 README，本记录仅保存本批决策和观察证据。

## 审查发现与修复合同

A `astra_pr284_full_chain_review`（Astra/high）对已合入的 #284 做完整只读独立审查，确认三项代码问题与一项文档遗漏。审查 base `e0f0c67a`、head `8176b2eb`、合并提交 `ac0841c3`；运行限制保留，不将源码判断或此前 PR 报告当作该代理亲自操作。

- P1：匿名回环 GET 可取得修订，POST 随后代用服务保存的 DS Key。修复要求私有 supervisor IPC 是调用身份的唯一获取渠道，HTTP 描述和上传均鉴权，能力绑定精确 Provider、代理地址与已确认实例代次；重启/释放撤销旧能力。配置修订只负责一致性，不充当 secret。
- P2：上传取新磁盘 Key、生成仍用启动 Key，配置延期应用时发生身份错配。要求 Worker 同次读取前/后设置指纹及材料，匹配 supervisor 已确认运行快照；未应用时上传前拒绝。在代理发现等异步等待后、真正出站前和上传后复核，释放实例取消在途上传。
- P2：热路径完整同步私有读取，Windows ACL 等待阻塞主事件循环。新增窄的 DS 材料 Worker，复用 SingleWorkerReader 的 ready、读取期限、合作关闭及物理退出归属；不使用 Relay 配置/授权语义，不在主线程读取私有材料。
- P3：指南与协议说明仍把所有第三方描述为内联图片，并混用 ChatGPT PUT 与 DS POST 的超时/重试。同步更新两个入口及模块合同，保持现有模型请求 48 MiB 和媒体输入限制。

## 实施及复查结果

入口沿授权渠道 → Application 能力与提交守卫 → Codex Client 的 Thread/Provider/config → Bootstrap 注入私有 IPC → supervisor 确认实例 → 材料 Worker → 受保护回环上传 → Files → fileId → Turn，检查 OpenAI/CLP 等未改替代路径。私有上传协议为 supervisor v5 下独立的 `imageUploadProtocolVersion=1`，不新增 Codex RPC 或用户持久化格式，不向配置、日志、指标或确认正文写调用身份。旧服务不支持该能力时失败关闭，要求更新后重启 App Server 与 Gateway，不自动重启用户服务。

使用隔离配置、虚构 DS Key 和本机 TLS 上游观察；CONNECT 代理只接受 DeepSeek 官方主机并转入任务自有 TLS 服务，其他目标拒绝，不调用真实账户。静态检查与行为证据分别记录，未新增或维护测试、探针或 guard 文件。

已完成初始类型/模块边界、生产构建和定向 Lint；`.mjs` 裸 `AbortSignal` 已改用 `globalThis.AbortSignal` 后通过。Worker 实现代理用临时空 Home 观察非法 Provider、缺失材料、关闭及物理退出。文档索引与链接检查通过。

新 A `astra_ds_upload_final_review`（Astra/high）已完成完整独立复查及修正后的源码增量复核，最终无未修复的确认问题。其发现并复核的两项 P2 关联修正为：App Server 正常及超时关闭均等待 Worker 与当前进程 ACL 实际退出；Bootstrap 将私有路由不可用映射为固定安全错误，保留配置应用及重启提示，并同步渠道诊断白名单。Bootstrap 模块索引遗漏及 OpenAI 合同主语歧义已补齐。A 覆盖 Application 能力与守卫、Client Thread/config/图片/Turn、私有 IPC、运行快照、Worker、出站和取消关闭，以及 OpenAI、CLP、自定义和聚合替代路径；下述运行由主代理执行，A 未重复运行。

真实原生 Thread 启动后，曾发现原有根路径检查不接受 Runtime 的 `/go/<账户>` 模型前缀，上传在 Turn 前被拒绝。已修改私有合同，显式区分准确模型地址和同源根路径上传地址，由 Runtime 使用与实例启动相同的账户映射构造，Client 与官方配置完整 URL 精确比较；A 也独立复核了该修正。首次沙箱遮蔽原生目录和临时材料缺 manifest 为已查明的观察环境问题，未据此修改产品安全合同；最终成功观察使用正式 CLI 服务入口。

## 实际行为证据

- 私有 IPC 成功授予运行实例能力；匿名及伪造 HTTP GET/POST 均为 403，上游上传计数为 0。合法上传返回 200 与 `file-api-manual-a-1`。
- 切换模式通过真实 `CodexAppServerClient` 创建 DS Thread 并发起含图 Turn；本机模型上游实际收到 `file-api-manual-a-2`、`inline=false`，原生 `turn/completed` 为 `completed`、`error=null`。固定 DS 主实例另独立运行同一链路，同样收到编号、没有图片 Base64，Turn 完成。
- 持有原生实例租约时把磁盘 Key 从虚构账户 A 改为 B：旧能力上传返回 502 固定安全错误，Files 上传计数仍为 2；私有路由读取拒绝并返回配置应用／重启提示。没有替新 Key 上传到仍使用旧 Key 的实例。
- 释放并重建该任务实例后，能力已旋转，旧能力返回 403，新能力上传返回 200 和 `file-api-manual-b-3`，本机上游身份为 B。
- 保持本机 Files 响应未结束时主动取消，调用方收到 `AbortError`，上游响应连接的 close 计数为 1。各次任务 App Server 收到 SIGTERM 后均已退出，本机服务与连接均关闭。
- 观察时没有 Gateway 指标接收者，模型代理报告固定的“模型代理指标连接失败”；模型请求和 Turn 已完成，此处不据此声称指标投递验收成功。

## 限制及后续验证归属

真实 DeepSeek、公有渠道、Windows/macOS 实机未观察，不能将本机上游替身的成功作为这些环境验收。Windows ACL 的故障物理收尾与旧宿主恢复提示为源码复核；代理发现窗口中的现场竞争、跨进程瞬时 ABA 未现场观察，前后指纹校验也不提供任意外部写入的原子性保证。后续在对应受控环境部署时由操作者完成这些观察；当前合同文档保留限制，不存在尚未完成的本批代码修正。

静态证据为类型与模块检查、生产构建、定向 ESLint、文档索引和本地链接检查以及差异空白检查通过；正常提交另由现有 Hook 执行交付检查，PR 中单独记录实际状态。服务定义与共享关闭预算未改变，已核对前台包装和四类 systemd/launchd 模板仍消费同一外层截止；未操作系统服务，也不需要重新安装服务定义，更新程序后需显式重启 App Server 与 Gateway。
