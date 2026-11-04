import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as variantPost } from "@/app/api/variant/route";
import { reviewResponseSchema, type ReviewResponse, type ReviewResult } from "@/lib/review-contract";
import { HOSTED_BODY_LIMIT, REQUEST_BUDGET, RESPONSE_BUDGET } from "@/lib/transport";
import { variantResponseSchema, type VariantResponse } from "@/lib/variant-contract";
import { CONTEXT_DROPPED_NOTE, MASKS_DROPPED_NOTE, fitReviewResponse, fitVariantResponse, jsonBytes } from "@/server/transport";
import { assessment, researchText } from "./fixtures";

// Synthetic payloads sized to probe the hosting budget. No live output.
beforeEach(() => vi.spyOn(console, "info").mockImplementation(() => undefined));
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const box = { left: 10, top: 10, right: 200, bottom: 200 };
function review(options: { maskChars?: number; contextChars?: number; passageChars?: number } = {}): ReviewResponse {
  const finding = { ...assessment().findings[0]!, visualConcept: "hand" };
  const passage = options.passageChars ? "p".repeat(options.passageChars) : researchText;
  const result: ReviewResult = {
    outcome: "emerging_signal", summary: "Synthetic", observations: [], findings: [finding], verifiedCaseIds: [], limitations: ["Synthetic"],
    searchCalls: [{ id: "s", status: "completed" }],
    sources: [{ id: "S1", evidenceState: "unverified", responseId: "r", messageId: "m", blockIndex: 0, citedPassage: passage.slice(0, 30_000),
      annotation: { type: "url_citation", url: "https://example.com/a", title: "A", start_index: 0, end_index: 10 } },
    ...Array.from({ length: Math.ceil(Math.max(0, passage.length - 30_000) / 30_000) }, (_, index) => ({
      id: `S${index + 2}`, evidenceState: "unverified" as const, responseId: "r", messageId: "m", blockIndex: 0, citedPassage: "q".repeat(30_000),
      annotation: { type: "url_citation" as const, url: `https://example.com/${index}`, title: "B", start_index: 0, end_index: 10 } }))],
    registry: { state: "available", checkedCases: 0, matchedCaseIds: [], evidence: [] },
    scope: { market: "KR", publicationDate: "2026-11-20", checkedAt: "2026-11-04T00:00:00Z", hasImage: true, hasCopy: true, completedSearches: 1, citedSources: 1, description: "Synthetic" },
    segmentation: { state: "completed", reason: null, model: "sam-3.1", image: { width: 400, height: 500 },
      concepts: [{ concept: "hand", findingIndexes: [0], status: "found", regionIds: Array.from({ length: 6 }, (_, index) => `G${index + 1}`) }],
      regions: Array.from({ length: 6 }, (_, index) => ({ id: `G${index + 1}`, concept: "hand", findingIndexes: [0], box, confidence: null, matchesForConcept: 6,
        mask: { path: `M0 0${"h1v1".repeat(Math.ceil((options.maskChars ?? 40) / 4))}z`.slice(0, 150_000), x: 10, y: 10, scaleX: 1, scaleY: 1 } })) },
    variantContext: options.contextChars ? "c".repeat(options.contextChars) : "token",
  };
  return reviewResponseSchema.parse({ state: "completed", result });
}

describe("hosting budgets", () => {
  it("keep a margin under the documented 4.5 MB Vercel body limit", () => {
    expect(REQUEST_BUDGET).toBeLessThan(HOSTED_BODY_LIMIT);
    expect(RESPONSE_BUDGET).toBeLessThan(HOSTED_BODY_LIMIT);
  });
});

describe("review response fitting", () => {
  it("returns a small review untouched", () => {
    const body = review();
    expect(fitReviewResponse(body)).toBe(body);
  });

  it("draws outlines as boxes first and says so", () => {
    const body = review({ maskChars: 150_000 });
    const fitted = fitReviewResponse(body, jsonBytes(body) - 100_000);
    if (fitted.state !== "completed") throw new Error("Expected a completed review");
    expect(fitted.result.segmentation.regions.every((region) => region.mask === null)).toBe(true);
    expect(fitted.result.segmentation.regions.map((region) => region.box)).toEqual(Array(6).fill(box));
    expect(fitted.result.variantContext).toBe("token");
    expect(fitted.result.limitations).toContain(MASKS_DROPPED_NOTE);
    expect(reviewResponseSchema.safeParse(fitted).success).toBe(true);
  });

  it("drops the variant context next, keeping every source and finding", () => {
    const body = review({ maskChars: 100_000, contextChars: 800_000 });
    const fitted = fitReviewResponse(body, 700_000);
    if (fitted.state !== "completed") throw new Error("Expected a completed review");
    expect(fitted.result.variantContext).toBeNull();
    expect(fitted.result.limitations).toEqual(expect.arrayContaining([MASKS_DROPPED_NOTE, CONTEXT_DROPPED_NOTE]));
    expect(fitted.result.sources).toHaveLength(1);
    expect(fitted.result.findings).toHaveLength(1);
    expect(jsonBytes(fitted)).toBeLessThanOrEqual(700_000);
  });

  it("fails closed when cited evidence alone exceeds the budget", () => {
    const body = review({ passageChars: 4_500_000 });
    const fitted = fitReviewResponse(body);
    expect(fitted).toMatchObject({ state: "failed", result: null, issue: { code: "response_too_large", retryable: true } });
    expect(fitted.state === "failed" && fitted.issue.message).toContain("never a sign that the creative is clear");
  });
});

describe("variant response fitting", () => {
  function variant(maskChars: number, cells: number): VariantResponse {
    return variantResponseSchema.parse({ state: "completed", result: {
      model: "muse-image-1.0", image: { dataUrl: `data:image/png;base64,${"A".repeat(3_000_000)}`, width: 400, height: 500 },
      transfer: { format: "png", width: 400, height: 500, bytes: 2_250_000 }, returnedSize: { width: 400, height: 500 },
      firstReview: { outcome: "emerging_signal", findings: 1 }, originalMatchesFirstReview: true,
      target: { regionId: "G1", concept: "hand", box }, instruction: "Replace it with a cup",
      preservation: { outsideChangedShare: 0.02, insideChangedShare: 0.7, cellsTruncated: false, material: false, targetChanged: true,
        changedCells: Array.from({ length: cells }, (_, index) => ({ left: index, top: index, right: index + 12, bottom: index + 12 })) },
      redetection: { status: "found", targetStillDetected: true, otherMatches: 5, otherMatchesMissing: 0,
        regions: Array.from({ length: 6 }, () => ({ box, mask: { path: "M0 0" + "h1".repeat(maskChars / 2), x: 0, y: 0, scaleX: 1, scaleY: 1 } })) },
      original: { state: "completed", outcome: "emerging_signal", findings: [], evidenceScope: "s", limitations: [] },
      variant: { state: "completed", outcome: "no_supported_concern_found", findings: [], evidenceScope: "s", limitations: [] },
      notes: Array.from({ length: 12 }, (_, index) => `Note ${index}`),
    } });
  }

  it("draws variant outlines as boxes, then leaves out the change map, and keeps every note it adds", () => {
    const body = variant(140_000, 800);
    const boxes = fitVariantResponse(body, jsonBytes(body) - 500_000);
    if (boxes.state !== "completed") throw new Error("Expected a completed comparison");
    expect(boxes.result.redetection.regions.every((region) => region.mask === null)).toBe(true);
    expect(boxes.result.preservation.changedCells).toHaveLength(800);
    expect(boxes.result.notes).toHaveLength(12);
    expect(boxes.result.notes.at(-1)).toContain("drawn as boxes");
    const tight = fitVariantResponse(body, jsonBytes(body) - 860_000);
    if (tight.state !== "completed") throw new Error("Expected a completed comparison");
    expect(tight.result.preservation).toMatchObject({ changedCells: [], cellsTruncated: true, outsideChangedShare: 0.02, insideChangedShare: 0.7 });
    expect(variantResponseSchema.safeParse(tight).success).toBe(true);
    expect(fitVariantResponse(body, 1_000_000)).toMatchObject({ state: "failed", issue: { code: "response_too_large" } });
  });
});

describe("variant route budget", () => {
  it("refuses a request above the hosting budget before reading the creative", async () => {
    vi.stubEnv("MODEL_API_KEY", "test");
    const response = await variantPost(new Request("http://localhost/api/variant", {
      method: "POST", body: "x", headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(REQUEST_BUDGET + 1) },
    }));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ state: "failed", issue: { code: "invalid_input", field: "image" } });
  });
});
