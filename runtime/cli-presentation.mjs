const colorCodes = Object.freeze({
  success: 32,
  failure: 31,
  note: 33,
  remediation: 36,
});

const prefixes = Object.freeze({
  success: "[通过]",
  failure: "[失败]",
  note: "[提示]",
  remediation: "[处理]",
});

const messagePrefixes = Object.freeze({
  success: "[成功]",
  failure: "[失败]",
  note: "[提示]",
  remediation: "[处理]",
});

export function cliColorsEnabled(stream = process.stdout, environment = process.env) {
  return stream.isTTY === true && environment.NO_COLOR === undefined;
}

export function colorizeCliText(
  kind,
  value,
  { stream = process.stdout, environment = process.env } = {},
) {
  const color = colorCodes[kind];
  if (color === undefined) throw new Error(`未知 CLI 状态类型：${kind}`);
  return cliColorsEnabled(stream, environment)
    ? `\u001b[${color}m${value}\u001b[0m`
    : value;
}

export function formatCliStatus(
  kind,
  name,
  detail,
  options,
) {
  const prefix = prefixes[kind];
  if (prefix === undefined) throw new Error(`未知 CLI 状态类型：${kind}`);
  return `${colorizeCliText(kind, prefix, options)} ${name}：${detail}`;
}

export function formatCliMessage(kind, message, options) {
  const prefix = messagePrefixes[kind];
  if (prefix === undefined) throw new Error(`未知 CLI 状态类型：${kind}`);
  return `${colorizeCliText(kind, prefix, options)} ${message}`;
}

export function writeCliMessage(
  kind,
  message,
  {
    stdout = process.stdout,
    stderr = process.stderr,
    environment = process.env,
    destination,
  } = {},
) {
  const stream = destination === "stderr" || (destination === undefined && kind === "failure")
    ? stderr
    : stdout;
  stream.write(`${formatCliMessage(kind, message, { stream, environment })}\n`);
}
