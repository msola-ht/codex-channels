export const primaryProviderUsage = `用法：codexc primary-provider <list|add|switch|remove> [参数]

管理 Codex 第三方主 Provider 候选：可配置多个候选，但同一时刻只激活一个。

  codexc primary-provider list
    列出当前激活的主 Provider 与全部自定义候选。
  codexc primary-provider add
    交互式新增或更新固定 ID（OpenAI）的主 Provider，并立即激活。
  codexc primary-provider switch openai
    切回官方 OpenAI 主 Provider（不运行登录，官方凭据保留；自定义候选移入私有备份）。
  codexc primary-provider switch <Provider ID> [模型]
    切换到自定义主 Provider；候选不在 config 时会从备份恢复；模型缺省保持当前设置。
  codexc primary-provider remove <Provider ID>
    删除候选；若删除的是当前激活项，将恢复官方 OpenAI 主 Provider。

修改后运行 codexc service restart all 生效。`;
