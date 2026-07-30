export async function readBoundedFetchBody(
  response: Response,
  maximumBytes: number,
  invalidContentLength: () => Error,
  tooLarge: () => Error,
): Promise<Buffer> {
  const rawLength = response.headers.get("content-length");
  if (rawLength !== null) {
    const contentLength = Number(rawLength);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      throw invalidContentLength();
    }
    if (contentLength > maximumBytes) {
      throw tooLarge();
    }
  }
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        return Buffer.concat(chunks, bytes);
      }
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(Buffer.from(chunk.value));
    }
  } finally {
    reader.releaseLock();
  }
}
