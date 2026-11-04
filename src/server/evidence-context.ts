import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { z } from "zod";
import { VISIBLE_TEXT_MAX_LINE, VISIBLE_TEXT_MAX_LINES, VISUAL_CONCEPT_MAX, outcomeSchema, registryContextSchema, regionSchema } from "@/lib/review-contract";
import type { EvidenceContext } from "./meta";

// A completed review returns its evidence context signed by the server. A variant request
// sends it back, so the variant is reassessed with exactly the passages and registry notes
// of that review. The signature stops a client from adding or editing evidence, and the
// hashes tie the context to the same image, copy and date. The JSON is compressed before
// signing, because the token travels back inside a request with a 4.5 MB hosting limit.
export const MAX_CONTEXT_TOKEN = 900_000;
// The signature is checked before anything is decompressed, and decompression is capped.
const MAX_CONTEXT_JSON_BYTES = 4_000_000;
const CONTEXT_TTL_MS = 6 * 60 * 60 * 1000;
const LABEL = "narak.variant-context.v2";

const payloadSchema = z.object({
  v: z.literal(2),
  issuedAt: z.number().int().positive(),
  publicationDate: z.string(),
  copyHash: z.string().length(64),
  imageHash: z.string().length(64),
  image: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict(),
  // The first review's result, so a comparison can show when the unchanged original is
  // assessed differently on the second run.
  firstReview: z.object({ outcome: outcomeSchema, findings: z.number().int().min(0).max(8) }).strict(),
  evidence: z.object({
    sources: z.array(z.object({
      sourceId: z.string().regex(/^S[1-9][0-9]*$/), title: z.string().max(2_000),
      citedPassage: z.string().min(1).max(30_000), evidenceState: z.literal("unverified"), host: z.string().max(253),
    }).strict()).min(1).max(60),
    registry: registryContextSchema,
    visibleText: z.array(z.string().max(VISIBLE_TEXT_MAX_LINE)).max(VISIBLE_TEXT_MAX_LINES),
  }).strict(),
  regions: z.array(z.object({
    id: regionSchema.shape.id, concept: z.string().min(2).max(VISUAL_CONCEPT_MAX), box: regionSchema.shape.box,
  }).strict()).min(1).max(24),
}).strict();
export type SignedContext = z.infer<typeof payloadSchema>;

export class ContextError extends Error {}

export const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

function signingKey(apiKey: string) {
  return createHmac("sha256", apiKey).update(LABEL).digest();
}

export function signContext(apiKey: string, context: {
  publicationDate: string; copy: string; imageDataUrl: string; image: { width: number; height: number };
  firstReview: SignedContext["firstReview"];
  evidence: EvidenceContext; regions: Array<{ id: string; concept: string; box: SignedContext["regions"][number]["box"] }>;
}, now = Date.now()): string | null {
  const payload = payloadSchema.safeParse({
    v: 2, issuedAt: now, publicationDate: context.publicationDate, copyHash: sha256(context.copy),
    imageHash: sha256(context.imageDataUrl), image: context.image, firstReview: context.firstReview, evidence: context.evidence,
    regions: context.regions.map(({ id, concept, box }) => ({ id, concept, box })),
  });
  if (!payload.success) return null;
  const body = deflateRawSync(Buffer.from(JSON.stringify(payload.data)), { level: 9 }).toString("base64url");
  const token = `${body}.${createHmac("sha256", signingKey(apiKey)).update(body).digest("base64url")}`;
  return token.length <= MAX_CONTEXT_TOKEN ? token : null;
}

export function verifyContext(apiKey: string, token: string, expected: {
  publicationDate: string; copy: string; imageDataUrl: string;
}, now = Date.now()): SignedContext {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined || token.length > MAX_CONTEXT_TOKEN) throw new ContextError("Malformed context");
  const actual = Buffer.from(signature, "base64url");
  const wanted = createHmac("sha256", signingKey(apiKey)).update(body).digest();
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) throw new ContextError("Signature mismatch");
  let parsed: SignedContext;
  try {
    const json = inflateRawSync(Buffer.from(body, "base64url"), { maxOutputLength: MAX_CONTEXT_JSON_BYTES });
    parsed = payloadSchema.parse(JSON.parse(json.toString("utf8")));
  }
  catch { throw new ContextError("Unreadable context"); }
  if (now - parsed.issuedAt > CONTEXT_TTL_MS || parsed.issuedAt > now + 60_000) throw new ContextError("Expired context");
  if (parsed.publicationDate !== expected.publicationDate || parsed.copyHash !== sha256(expected.copy)
    || parsed.imageHash !== sha256(expected.imageDataUrl)) throw new ContextError("Different creative");
  return parsed;
}
