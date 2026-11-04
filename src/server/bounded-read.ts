import "server-only";

export class ProviderHttpError extends Error {
  constructor(readonly status: number) {
    super(`Provider returned HTTP ${status}`);
    this.name = "ProviderHttpError";
  }
}

export class ProviderOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderOutputError";
  }
}

// Read a provider response body with a hard size limit, honouring cancellation.
// Raw provider output is never logged or persisted.
export async function readBoundedJson(response: Response, signal: AbortSignal, limit: number): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderHttpError(response.status);
  }
  if (!response.body) throw new ProviderOutputError("Empty provider response");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new ProviderOutputError("Provider response exceeded the size limit");
      chunks.push(part.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ProviderOutputError("Provider response was not JSON");
  }
}
