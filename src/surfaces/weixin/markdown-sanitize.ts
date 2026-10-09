/**
 * 中性化微信交互文本中的 Markdown 控制字符。
 *
 * 微信客户端会把未转义的 `*`、`_`、`#` 等字符解析为格式，破坏审批标题、问题与选项的
 * 固定布局，因此在交互文案边界统一替换为等价的全角或安全字符。
 */
export function sanitizeWeixinMarkdownText(value: string): string {
  return value
    .replaceAll("`", "ˋ")
    .replaceAll("*", "＊")
    .replaceAll("_", "＿")
    .replaceAll("~", "～")
    .replaceAll("#", "＃")
    .replaceAll(">", "＞")
    .replaceAll("[", "［")
    .replaceAll("]", "］");
}

/** Hook 信任预览必须保留字面原文；由组合根注入 Application 审查策略。 */
export function canPreserveWeixinHookReviewText(value: string): boolean {
  return sanitizeWeixinMarkdownText(value) === value;
}
