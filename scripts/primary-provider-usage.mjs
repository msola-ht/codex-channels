export const primaryProviderUsage = `用法：codexc primary-provider <list|add|switch|remove|recover> [参数]

管理 Codex 兼容 Provider（Responses 接口，使用 Codex 官方模型目录）：固定模式只使用一个主 Provider，切换模式可同时启用多个独立 Provider。

  codexc primary-provider list [--json]
    列出当前主实例、已启用的切换 Provider、固定模式候选与私有备份。
  codexc primary-provider add [--custom-models]
    --custom-models 使用独立模型目录，手填模型及能力；省略时使用 Codex 官方目录。
    交互式新增固定或切换 Provider；Provider ID 可从 URL 主机名提取，或选择推荐的 OpenAI。
    上游模型 ID 由用户输入并校验 Codex 官方模型目录；不请求第三方 /models。已有 ID 必须从 codexc setup 编辑。
  codexc primary-provider switch openai [--yes]
    恢复官方 OpenAI 主 Provider（不运行登录，官方凭据保留；固定候选移入私有备份；切换 Provider 保持启用）。
    执行前会二次确认，并提示将把 model_provider 写回 openai；未指定模型时，从自定义切回官方会清空顶层 model（已在官方模式时保留）。
  codexc primary-provider switch <Provider ID> [模型] [--yes]
    把目标转换为固定主 Provider；若目标当前是独立切换 Provider，会移除其独立 Profile。
    执行前会二次确认，并提示将改写 Codex 主配置的 model_provider / model。
    传 --yes 跳过确认（适合脚本化调用）。
    备份候选会先恢复；模型缺省时保持候选设置，切换 Profile 使用自身默认模型。
  codexc primary-provider remove <Provider ID>
    删除配置或私有备份中的候选；若删除的是当前激活项，将恢复官方 OpenAI 主 Provider。

  codexc primary-provider recover <Provider ID> <keep|rollback> [--yes]
    恢复中断的自定义 Responses 模型目录保存；存在上下文联动事务时恢复整批 DS/RS 目录及 Profile；先停止服务并核对配置。keep 保留新目录，rollback 恢复备份。

修改后运行 codexc service restart all 生效。`;
