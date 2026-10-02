import type { TextFileValidationErrorCode } from "./text-file-input.js";

export function formatTextFileDownloadFailed(platform: string): string {
  return /^[A-Za-z]/u.test(platform)
    ? `下载 ${platform} 文件失败，请重新发送`
    : `下载${platform}文件失败，请重新发送`;
}

export function formatTextFileTooLarge(platform: string): string {
  return `${platformLabel(platform)}文本文件超过 1,000,000 字节限制`;
}

export function formatUnsupportedTextFile(
  platform: string,
  reason: TextFileValidationErrorCode = "unsupported",
): string {
  const details: Record<TextFileValidationErrorCode, string> = {
    "read-timeout": "文件读取超过 30 秒，请重新发送或缩小文件",
    "too-large": "文件超过 1,000,000 字节限制",
    "invalid-name": "文件名无效，请使用不含路径或控制字符的文件名",
    "invalid-utf8": "文件不是有效的 UTF-8 文本，请转换编码后重新发送",
    "empty": "文件没有可读取的文本内容",
    "control-characters": "文件含不支持的控制字符，可能是二进制文件；常见终端转义序列已自动清理",
    "unsupported": "文件内容格式不受支持，请发送 UTF-8 文本文件",
  };
  return `网关无法读取${platformLabel(platform)}附件：${details[reason]}`;
}

function platformLabel(platform: string): string {
  return /^[A-Za-z]/u.test(platform) ? `${platform} ` : platform;
}
