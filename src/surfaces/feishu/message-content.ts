export function encodeFeishuPostContent(markdown: string): string {
  const safeMarkdown = sanitizeFeishuMarkdown(markdown);
  return JSON.stringify({
    zh_cn: {
      title: "",
      content: [[{
        tag: "md",
        text: safeMarkdown,
      }]],
    },
  });
}

export function sanitizeFeishuMarkdown(markdown: string): string {
  return markdown.replace(
    /<(?=\/?at(?:\s|>))/giu,
    "&lt;",
  );
}
