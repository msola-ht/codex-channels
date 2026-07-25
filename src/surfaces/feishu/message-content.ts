export function encodeFeishuPostContent(markdown: string): string {
  const safeMarkdown = markdown.replace(
    /<(?=\/?at(?:\s|>))/giu,
    "&lt;",
  );
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
