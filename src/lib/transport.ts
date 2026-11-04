// Vercel Functions accept at most 4.5 MB in a request body and in a response body
// (https://vercel.com/docs/functions/limitations, checked 2026-11-04). A larger payload
// never reaches the route and comes back as a 413 FUNCTION_PAYLOAD_TOO_LARGE text reply.
// NARAK keeps every request and every JSON reply under these budgets, with a margin
// for multipart framing and headers, so the route decides what happens to large data.
export const HOSTED_BODY_LIMIT = 4_500_000;
export const REQUEST_BUDGET = 4_400_000;
export const RESPONSE_BUDGET = 4_300_000;

// Multipart framing, field names, the region ID and the variant instruction together
// stay well under this allowance.
export const MULTIPART_ALLOWANCE = 8_192;

export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

// The variant request carries the original upload, the copy and the signed context.
export function variantRequestBytes(parts: { uploadBytes: number; copy: string; context: string }): number {
  return parts.uploadBytes + utf8Length(parts.copy) + utf8Length(parts.context) + MULTIPART_ALLOWANCE;
}
