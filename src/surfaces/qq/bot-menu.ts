export type QqBotMenuFailure = "invalid-menu" | "name-conflict" | "menu-full";

/** Contains only local classifications; never includes upstream menu content. */
export class QqBotMenuError extends Error {
  constructor(readonly reason: QqBotMenuFailure) {
    super(`QQ menu: ${reason}`);
    this.name = "QqBotMenuError";
  }
}

export interface QqBotMenuSnapshot {
  version: number | undefined;
  menu: Record<string, unknown> | null | undefined;
}

const codexItem = { type: "send_message", name: "Codex", send_message: "/help" };

function invalid(): never {
  throw new QqBotMenuError("invalid-menu");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  return value as Record<string, unknown>;
}

function fields(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Reflect.ownKeys(value).some(key => typeof key !== "string" || !allowed.includes(key))) invalid();
}

function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || /[\uD800-\uDFFF]/u.test(value)) invalid();
}

function name(value: unknown, maximum: number): void {
  text(value);
  if (/\p{Cc}/u.test(value)
    || [...value].reduce((size, character) => size + ((character.codePointAt(0) ?? 0) <= 0x7f ? 1 : 2), 0) > maximum) invalid();
}

function item(value: unknown, nested: boolean): void {
  const data = record(value);
  name(data.name, nested ? 14 : 10);
  switch (data.type) {
    case "send_message":
      fields(data, ["type", "name", "send_message", "icon"]);
      text(data.send_message);
      // QQ adds a default HTTPS icon when reading a send_message item back.
      // Preserve it as presentation data; never fetch or synthesize it.
      if (Object.hasOwn(data, "icon")) {
        text(data.icon);
        if (data.icon.length > 2048 || /\p{Cc}/u.test(data.icon)) invalid();
        try {
          const url = new URL(data.icon);
          if (url.protocol !== "https:" || url.username || url.password) invalid();
        } catch { invalid(); }
      }
      break;
    case "link": {
      fields(data, ["type", "name", "link"]);
      text(data.link);
      if (!data.link.startsWith("https://")) invalid();
      try { if (new URL(data.link).protocol !== "https:") invalid(); }
      catch { invalid(); }
      break;
    }
    case "switch": {
      if (nested) invalid();
      fields(data, ["type", "name", "switch"]);
      const settings = record(data.switch);
      fields(settings, ["switch_id", "default"]);
      text(settings.switch_id);
      if (typeof settings.default !== "boolean") invalid();
      break;
    }
    case "menu":
      if (nested) invalid();
      fields(data, ["type", "name", "sub_menu_items"]);
      if (!Array.isArray(data.sub_menu_items) || data.sub_menu_items.length > 5) invalid();
      for (const child of data.sub_menu_items) item(child, true);
      break;
    default:
      invalid();
  }
}

/** Missing/null means no global menu. All existing fields must be understood before replacement. */
export function parseQqBotMenuSnapshot(value: { version: number | undefined; menu: unknown }): QqBotMenuSnapshot {
  // Observed QQ unconfigured response is exactly {menu:{}} with no version.
  // Preserve that state explicitly instead of inventing a numeric revision.
  const unconfigured = value.version === undefined && value.menu !== null && value.menu !== undefined
    && Reflect.ownKeys(record(value.menu)).length === 0;
  if (!unconfigured && (typeof value.version !== "number" || !Number.isSafeInteger(value.version) || value.version < 0)) invalid();
  if (value.menu === null || value.menu === undefined) return { version: value.version, menu: value.menu };
  const menu = record(value.menu);
  fields(menu, ["items"]);
  if (Object.hasOwn(menu, "items")) {
    if (!Array.isArray(menu.items) || menu.items.length > 10) invalid();
    for (const entry of menu.items) item(entry, false);
  }
  return { version: value.version, menu: structuredClone(menu) };
}

/** JSON field order does not change menu meaning; list order and absent fields do. */
export function sameQqBotMenuContent(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameQqBotMenuContent(value, right[index]));
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  return Object.keys(a).length === Object.keys(b).length
    && Object.keys(a).every(key => Object.hasOwn(b, key) && sameQqBotMenuContent(a[key], b[key]));
}

export function sameQqBotMenuSnapshot(left: QqBotMenuSnapshot, right: QqBotMenuSnapshot): boolean {
  return left.version === right.version && sameQqBotMenuContent(left.menu, right.menu);
}

function matchesPlannedItem(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  if (actual.type === "send_message" && expected.type === "send_message"
    && !Object.hasOwn(expected, "icon") && Object.hasOwn(actual, "icon")) {
    const content = { ...actual };
    delete content.icon;
    return sameQqBotMenuContent(content, expected);
  }
  return sameQqBotMenuContent(actual, expected);
}

/** Only server-added icons on new command items may differ from a validated plan.
 * Existing icons and all snapshot comparisons remain exact. */
export function matchesQqBotMenuPlan(actual: Record<string, unknown> | null | undefined, expected: Record<string, unknown>): boolean {
  if (!actual || !Array.isArray(actual.items) || !Array.isArray(expected.items)
    || actual.items.length !== expected.items.length) return false;
  const { items: actualItems, ...actualFields } = actual;
  const { items: expectedItems, ...expectedFields } = expected;
  return sameQqBotMenuContent(actualFields, expectedFields)
    && (actualItems as Array<Record<string, unknown>>).every((entry, index) =>
      matchesPlannedItem(entry, (expectedItems as Array<Record<string, unknown>>)[index]!));
}

export function planQqCodexBotMenu(snapshot: QqBotMenuSnapshot): {
  action: "unchanged" | "add";
  menu: Record<string, unknown>;
} {
  const validated = parseQqBotMenuSnapshot(snapshot);
  const menu = validated.menu ?? {};
  const items = (menu.items ?? []) as Array<Record<string, unknown>>;
  const existing = items.filter(entry => entry.name === codexItem.name);
  if (existing.length > 0) {
    if (existing.length !== 1 || !matchesPlannedItem(existing[0]!, codexItem)) {
      throw new QqBotMenuError("name-conflict");
    }
    return { action: "unchanged", menu };
  }
  if (items.length === 10) throw new QqBotMenuError("menu-full");
  return { action: "add", menu: { ...menu, items: [...items, { ...codexItem }] } };
}
