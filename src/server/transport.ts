import "server-only";
import { RESPONSE_BUDGET, utf8Length } from "@/lib/transport";
import type { ReviewIssue, ReviewResponse } from "@/lib/review-contract";
import type { VariantResponse } from "@/lib/variant-contract";

export const jsonBytes = (value: unknown) => utf8Length(JSON.stringify(value));

export const MASKS_DROPPED_NOTE = "Outlines are drawn as boxes in this review. The full SAM 3.1 outlines would have exceeded the response size limit of the hosting platform.";
export const CONTEXT_DROPPED_NOTE = "Variant testing is off for this review because the result would have exceeded the response size limit of the hosting platform.";

function tooLarge(kind: "review" | "variant"): { state: "failed"; result: null; issue: ReviewIssue } {
  return { state: "failed", result: null, issue: {
    code: "response_too_large", retryable: true,
    message: kind === "review"
      ? "This review produced more evidence than the hosting platform can return at once. No assessment is shown, and an unfinished review is never a sign that the creative is clear. Please try again."
      : "This comparison is larger than the hosting platform can return at once. Nothing was compared. Please try again.",
  } };
}

// Keep a completed review under the response budget. Mask outlines go first, because each
// region keeps its SAM 3.1 box. The variant context goes next. Cited passages, findings and
// registry notes are never trimmed, so a review that still does not fit fails closed.
export function fitReviewResponse(body: ReviewResponse, budget = RESPONSE_BUDGET): ReviewResponse {
  if (body.state !== "completed" || jsonBytes(body) <= budget) return body;
  let result = body.result;
  if (result.segmentation.regions.some((region) => region.mask)) {
    result = {
      ...result,
      segmentation: { ...result.segmentation, regions: result.segmentation.regions.map((region) => ({ ...region, mask: null })) },
      limitations: [...result.limitations, MASKS_DROPPED_NOTE],
    };
    if (jsonBytes({ state: "completed", result }) <= budget) return { state: "completed", result };
  }
  if (result.variantContext) {
    result = { ...result, variantContext: null, limitations: [...result.limitations, CONTEXT_DROPPED_NOTE] };
    if (jsonBytes({ state: "completed", result }) <= budget) return { state: "completed", result };
  }
  return tooLarge("review");
}

// Keep a completed comparison under the response budget. The variant image is already
// sized for transfer. SAM outlines on the variant become boxes, then the drawn strips of
// measured change are left out. The measured shares themselves always stay.
export function fitVariantResponse(body: VariantResponse, budget = RESPONSE_BUDGET): VariantResponse {
  if (body.state !== "completed" || jsonBytes(body) <= budget) return body;
  let result = body.result;
  if (result.redetection.regions.some((region) => region.mask)) {
    result = {
      ...result,
      redetection: { ...result.redetection, regions: result.redetection.regions.map((region) => ({ ...region, mask: null })) },
      notes: [...result.notes.slice(0, 11), "SAM 3.1 outlines on the variant are drawn as boxes to stay within the response size limit."],
    };
    if (jsonBytes({ state: "completed", result }) <= budget) return { state: "completed", result };
  }
  if (result.preservation.changedCells.length) {
    result = {
      ...result,
      preservation: { ...result.preservation, changedCells: [], cellsTruncated: true },
      notes: [...result.notes.slice(0, 11), "The map of changed areas is left out to stay within the response size limit. The measured shares are unchanged."],
    };
    if (jsonBytes({ state: "completed", result }) <= budget) return { state: "completed", result };
  }
  return tooLarge("variant");
}
