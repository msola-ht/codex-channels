export type FeishuCardTemplate = "blue" | "green" | "grey";

export interface FeishuCardKitDocument {
  schema: "2.0";
  config: {
    update_multi: true;
    wide_screen_mode: true;
  };
  header: {
    template: FeishuCardTemplate;
    title: {
      tag: "plain_text";
      content: string;
    };
  };
  body: {
    elements: Array<Record<string, unknown>>;
  };
}

export function feishuCardShell(
  template: FeishuCardTemplate,
  title: string,
  elements: Array<Record<string, unknown>>,
): FeishuCardKitDocument {
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      wide_screen_mode: true,
    },
    header: {
      template,
      title: {
        tag: "plain_text",
        content: title,
      },
    },
    body: { elements },
  };
}

export function feishuCardMarkdown(content: string): Record<string, unknown> {
  return {
    tag: "markdown",
    content,
  };
}

export function feishuCardPlainText(content: string): Record<string, unknown> {
  return {
    tag: "div",
    text: {
      tag: "plain_text",
      content,
    },
  };
}

export function feishuCardNote(content: string): Record<string, unknown> {
  return {
    tag: "note",
    elements: [{
      tag: "plain_text",
      content,
    }],
  };
}

export function feishuCardButton(
  text: string,
  type: "primary" | "default" | "danger",
  value: Record<string, unknown>,
): Record<string, unknown> {
  return {
    tag: "button",
    type,
    text: {
      tag: "plain_text",
      content: text,
    },
    value,
  };
}

export function feishuCardColumnSetRow(
  elements: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    tag: "column_set",
    flex_mode: "stretch",
    horizontal_spacing: "8px",
    columns: elements.map((element) => ({
      tag: "column",
      width: "weighted",
      weight: 1,
      elements: [element],
    })),
  };
}

export function feishuCardColumnSetRows(
  elements: ReadonlyArray<Record<string, unknown>>,
  columnsPerRow = 3,
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let index = 0; index < elements.length; index += columnsPerRow) {
    rows.push(feishuCardColumnSetRow(elements.slice(index, index + columnsPerRow)));
  }
  return rows;
}
