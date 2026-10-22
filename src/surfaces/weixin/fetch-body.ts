export async function readBoundedFetchBody(
  response: Response,
  maximumBytes: number,
  invalidContentLength: () => Error,
  tooLarge: () => Error,
  signal: AbortSignal,
): Promise<Buffer> {
  if (signal.aborted) {
    void response.body?.cancel().catch(() => undefined);
    signal.throwIfAborted();
  }
  const rawLength = response.headers.get("content-length");
  if (rawLength !== null) {
    const contentLength = Number(rawLength);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      void response.body?.cancel().catch(() => undefined);
      throw invalidContentLength();
    }
    if (contentLength > maximumBytes) {
      void response.body?.cancel().catch(() => undefined);
      throw tooLarge();
    }
  }
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) {
        return Buffer.concat(chunks, bytes);
      }
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) {
        void reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(Buffer.from(chunk.value));
    }
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
