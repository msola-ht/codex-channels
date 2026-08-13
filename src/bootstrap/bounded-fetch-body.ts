export interface BoundedFetchBodyErrors {
  invalidContentLength: () => Error;
  tooLarge: () => Error;
  missingBody?: () => Error;
}

export async function readBoundedFetchBody(
  response: Response,
  maximumBytes: number,
  { invalidContentLength, tooLarge, missingBody }: BoundedFetchBodyErrors,
): Promise<Buffer> {
  const rawLength = response.headers.get("content-length");
  if (rawLength !== null) {
    const contentLength = Number(rawLength);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      await response.body?.cancel().catch(() => undefined);
      throw invalidContentLength();
    }
    if (contentLength > maximumBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw tooLarge();
    }
  }
  if (!response.body) {
    if (missingBody) throw missingBody();
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return Buffer.concat(chunks, bytes);
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(Buffer.from(chunk.value));
    }
  } finally {
    reader.releaseLock();
  }
}
