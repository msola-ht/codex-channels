export function formatTextFileDownloadFailed(platform: string): string {
  return /^[A-Za-z]/u.test(platform)
    ? `下载 ${platform} 文件失败，请重新发送`
    : `下载${platform}文件失败，请重新发送`;
}

export function formatTextFileTooLarge(platform: string): string {
  return `${platformLabel(platform)}文本文件超过 1,000,000 字节限制`;
}

export function formatUnsupportedTextFile(platform: string): string {
  return `${platformLabel(platform)}当前仅支持 UTF-8 文本文件`;
}

function platformLabel(platform: string): string {
  return /^[A-Za-z]/u.test(platform) ? `${platform} ` : platform;
}
