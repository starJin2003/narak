import { z } from "zod";
import { findingSchema, issueSchema, outcomeSchema, regionSchema, VISUAL_CONCEPT_MAX } from "./review-contract";

export const MAX_INSTRUCTION_LENGTH = 200;
// Muse Image, then SAM 3.1 and two assessments side by side, inside a 210-second route.
export const VARIANT_TIMEOUT_MS = 190_000;

const pixel = z.number().int().min(0).max(20_000);
const size = z.object({ width: z.number().int().positive().max(20_000), height: z.number().int().positive().max(20_000) }).strict();
const box = regionSchema.shape.box;

// Each version is reassessed with the same passages, registry notes and date.
export const reassessmentSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("completed"), outcome: outcomeSchema, findings: z.array(findingSchema).max(8),
    evidenceScope: z.string().max(2_000), limitations: z.array(z.string().max(2_000)).max(8),
  }).strict(),
  z.object({ state: z.literal("failed"), message: z.string().max(500) }).strict(),
]);
export type Reassessment = z.infer<typeof reassessmentSchema>;

// Muse Image rejects aspect ratios beyond 16 to 1 (https://dev.meta.ai/docs/image-generation).
export const MAX_EDIT_ASPECT_RATIO = 16;

export const variantResultSchema = z.object({
  model: z.literal("muse-image-1.0"),
  // width and height are the coordinate space shared with the original. The encoded
  // bitmap may be smaller when it had to be reduced for transfer.
  image: z.object({ dataUrl: z.string().regex(/^data:image\/(png|webp|jpeg);base64,/).max(16_000_000), ...size.shape }).strict(),
  transfer: z.object({ format: z.enum(["png", "jpeg"]), width: size.shape.width, height: size.shape.height, bytes: z.number().int().positive() }).strict(),
  returnedSize: size,
  // The first review of the original, signed by the server, and whether the unchanged
  // original was assessed the same way again. null when that reassessment did not finish.
  firstReview: z.object({ outcome: outcomeSchema, findings: z.number().int().min(0).max(8) }).strict(),
  originalMatchesFirstReview: z.boolean().nullable(),
  target: z.object({ regionId: regionSchema.shape.id, concept: z.string().min(2).max(VISUAL_CONCEPT_MAX), box }).strict(),
  instruction: z.string().min(1).max(MAX_INSTRUCTION_LENGTH),
  // Measured by comparing the two images, never reported by a model.
  preservation: z.object({
    outsideChangedShare: z.number().min(0).max(1), insideChangedShare: z.number().min(0).max(1),
    changedCells: z.array(z.object({ left: pixel, top: pixel, right: pixel, bottom: pixel }).strict()).max(800),
    cellsTruncated: z.boolean(), material: z.boolean(), targetChanged: z.boolean(),
  }).strict(),
  // SAM 3.1 on the variant. Each original match is looked up again, so an edit that removed
  // a different match than the selected one is visible. null when the check did not finish.
  redetection: z.object({
    status: z.enum(["found", "not_found", "failed", "skipped"]),
    regions: z.array(regionSchema.pick({ box: true, mask: true })).max(6),
    targetStillDetected: z.boolean().nullable(),
    otherMatches: z.number().int().min(0).max(11),
    otherMatchesMissing: z.number().int().min(0).max(11).nullable(),
  }).strict(),
  original: reassessmentSchema,
  variant: reassessmentSchema,
  notes: z.array(z.string().max(600)).max(12),
}).strict();
export type VariantResult = z.infer<typeof variantResultSchema>;

export const variantResponseSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("completed"), result: variantResultSchema }),
  z.object({ state: z.enum(["incomplete", "unavailable", "failed"]), result: z.null(), issue: issueSchema }),
]);
export type VariantResponse = z.infer<typeof variantResponseSchema>;
