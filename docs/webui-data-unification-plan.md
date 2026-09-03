# WebUI 与渠道数据统一改造步骤

## 目标

统一官方账户数据、Gateway 统计数据和计算结果的存储与查询入口，使 WebUI 和飞书、微信、Telegram 等渠道卡片使用同一套数据，不再各自请求和计算。

## 目标链路

```text
官方只读接口 / Gateway 代理观测
              ↓
        采集与规范化
              ↓
        统一数据库读模型
              ↓
          统一计算服务
              ↓
       Application 查询端口
          ↙             ↘
       WebUI          渠道卡片
```

## 数据分层

### 官方账户数据

- OpenAI：账户用量、额度和重置时间；区分官方直接读取与代理响应观测。
- DeepSeek：官方账户余额。
- OpenCode Go：官方账户、配额窗口和模型用量。
- 只保存展示和计算所需字段、来源、观测时间和可用状态，不保存 Token、Cookie 或完整敏感响应。

### 统计数据

- 请求、Token、费用、错误、Provider、Thread 和额度快照。
- 由 Gateway 代理和指标采集链路写入指标数据库。

### 计算数据

- 总量、成功率、费用汇总、趋势、额度周期、均价和速度。
- 统一计算，WebUI 与渠道不重复推导。

## 实施步骤

1. **盘点现有来源**
   - 列出每个官方适配器、代理采集点、数据库表、计算函数和现有 API。
   - 标注字段来源、单位、更新时间和是否允许为空。

2. **定义统一数据库模型**
   - 分离账户快照、请求统计、额度快照和计算结果。
   - 保留来源、账户/Provider、设备、观测时间和状态字段。
   - 明确历史数据处理方式，不做隐式迁移。

3. **统一采集入口**
   - OpenAI、DeepSeek、OpenCode Go 适配器只负责读取和规范化。
   - Gateway 代理只负责观测和写入统计数据。
   - 采集失败写入可观察状态，不伪造成功数据。

4. **统一计算入口**
   - 将费用、Token、趋势、额度周期等计算集中到同一服务。
   - 统一时间单位、币种、精度和缺失值语义。

5. **统一查询接口**
   - Application 层提供平台无关的账户摘要、指标摘要和明细查询。
   - WebUI API 与渠道卡片接口只做展示格式适配。

6. **整理 WebUI 数据获取**
   - 页面级获取一次，卡片只接收数据。
   - 本机概览、账户状态、全局概览分别复用统一快照。
   - 删除重复请求和未使用的数据入口。

7. **整理渠道卡片**
   - 复用 Application 查询端口。
   - 不直接访问 WebUI HTTP API，不直接访问数据库，不重复调用官方接口。

8. **迁移与验证**
   - 先兼容读取现有数据库，再按明确版本执行迁移。
   - 验证 WebUI、各渠道卡片和 CLI 的字段、单位、更新时间及失败状态一致。

## 数据库模型草案

账户快照与请求指标分开存储，不把账户余额或额度字段追加到 `model_request_metrics`：

```text
account_sources
  source_id / provider / account_id / display_name / enabled

account_snapshots
  source_id / observed_at_ms / available / usage_json / limits_json
```

- `usage_json`、`limits_json` 只保存已脱敏、已规范化的展示字段，不保存凭据和完整上游响应。
- `source_id + observed_at_ms` 用于幂等写入和历史追踪。
- 余额、额度窗口和模型用量分别保留，避免把不同 Provider 的字段强行合并。
- 额度窗口当前作为规范化 `usage_json` 的 Provider 结构保存；拆分为 `account_quota_windows` 前先补齐跨 Provider 查询契约。
- 计算结果继续由查询层按快照生成；只有确认查询热点后才增加派生表。
- 新表进入指标库前必须升级 Schema 版本、提供备份/回滚路径，并补齐本地与中心库测试。

## 完成标准

- 每个数据字段都有唯一来源和明确单位。
- 同一份账户或统计数据在一次展示流程中只获取一次。
- WebUI 与渠道卡片展示同一数据库快照和计算口径。
- 官方账户数据与 Gateway 统计数据不再混用。
- 凭据不进入数据库展示数据、接口响应或日志。
- 新增卡片只需复用查询接口，不新增独立数据采集链路。

## 当前第一批改造范围

先处理 WebUI 控制台：统一 OpenAI、DeepSeek、OpenCode Go 三类账户源，统一本机/全局指标查询，消除 `settings` 和本地 `overview` 的重复获取；完成后再接入渠道卡片。

## 实施进度

> 当前工作区状态：`105a7f8` 之后存在未提交改动，内容为“账户服务接入快照写入”。切换对话后应从该工作区继续，不要重复创建 Schema v12 或 WebUI 第一批改造。

- [x] 建立数据链路与分层步骤文档。
- [x] `settings` 收拢到 `CurrencyProvider`，页面内复用同一份设置数据。
- [x] 本机 `overview` 提升到控制台页面级，范围切换和账户额度卡复用同一请求。
- [x] 本地范围不再请求中心设备列表，切换到全局范围时再加载。
- [x] DeepSeek 与 OpenCode Go 官方只读源收拢为统一账户源 hook。
- [x] 完成账户快照数据库模型草案与持久化边界审查。
- [x] 建立平台无关的官方账户快照查询端口类型。
- [x] 建立 Provider 返回值到统一官方账户快照的规范化函数。
- [x] 指标数据库升级到 Schema v12，新增账户源与账户快照表，支持幂等写入和最新快照读取。
- [x] Provider 账户查询服务接入快照写入端口，官方只读查询结果统一落入快照读模型。
- [x] WebUI 账户卡片改为读取指标库统一快照接口，页面不再直接请求 DeepSeek/OpenCode Go 官方接口。
- [x] 将 OpenAI、DeepSeek、OpenCode Go 官方账户快照统一写入数据库读模型。
- [x] 为 WebUI 与渠道提供统一账户快照查询端口；渠道卡片沿用 Application 产生的账户事件与共享格式器。
- [ ] 清理全局设备数据的非必要获取并迁移渠道卡片。

本批审查确认：飞书、微信、Telegram 的账户与额度卡片均只消费 Application/Core 发出的
`account.updated`、`account.rateLimits.updated` 事件，并复用 `runtime-status-format`，没有直接
调用官方适配器、WebUI HTTP API 或指标数据库；OpenCode Go 快照中的秒级重置时间在 WebUI 边界统一转换为毫秒。

账户刷新策略暂定为按需刷新：渠道执行 `/usage` 或 `/limits` 时由 Gateway 实时查询并写入快照，
WebUI 只读快照；暂不增加定时采集或 WebUI↔Gateway IPC，避免重复的跨进程凭据访问和刷新协议。

## 下一批一次性完成范围

下一轮不要再拆成单个小步骤，按一个完整批次推进：

1. 将快照写入服务接入所有官方账户读取路径，并补齐成功、失败、不可用三种状态测试。
2. 增加 Application 统一账户快照查询服务，WebUI 账户卡片改为读取该服务。
3. 盘点并迁移飞书、微信、Telegram 卡片中的账户/额度读取，禁止卡片直接调用官方适配器或 WebUI HTTP API。
4. 统一 WebUI 与渠道卡片的字段名、单位、时间戳和缺失值语义。
5. 补齐接口字段审查：重点检查 `GlobalOverviewResponse`、`GlobalRequestRow`、`ThreadRunResponse.threadAggregate` 与额度重置时间单位。
6. 为渠道卡片和 WebUI 增加共享查询契约测试，最后统一运行完整门禁；确认无误后再提交一个完整批次。
