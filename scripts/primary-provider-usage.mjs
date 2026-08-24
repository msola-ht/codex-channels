export const primaryProviderUsage = `用法：codexc primary-provider <list|add|switch|remove> [参数]

管理 OpenAI Responses 兼容 Provider：固定模式只使用一个主 Provider，切换模式可同时启用多个独立 Provider。

  codexc primary-provider list
    列出当前主实例、已启用的切换 Provider、固定模式候选与私有备份。
  codexc primary-provider add
    交互式新增固定或切换 Provider；Provider ID 可从 URL 主机名提取，或选择推荐的 OpenAI。
    上游模型 ID 由用户输入并校验 Codex 官方模型目录；不请求第三方 /models。已有 ID 必须从 codexc setup 编辑。
  codexc primary-provider switch openai
    恢复官方 OpenAI 主 Provider（不运行登录，官方凭据保留；固定候选移入私有备份；切换 Provider 保持启用）。
  codexc primary-provider switch <Provider ID> [模型]
    把目标转换为固定主 Provider；若目标当前是独立切换 Provider，会移除其独立 Profile。
    备份候选会先恢复；模型缺省时保持候选设置，切换 Profile 使用自身默认模型。
  codexc primary-provider remove <Provider ID>
    删除配置或私有备份中的候选；若删除的是当前激活项，将恢复官方 OpenAI 主 Provider。

修改后运行 codexc service restart all 生效。`;
