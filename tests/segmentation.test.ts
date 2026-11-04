import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  conceptsFromFindings, normalizeConcept, objectsFromSamText, parseSamOutput,
  samFrameSize, samOutputText, segmentConcept, segmentImage,
} from "@/server/segmentation";
import { reviewWithMeta } from "@/server/meta";
import { resultSchema, type ReviewInput } from "@/lib/review-contract";
import { assessment, assessmentResponse, researchResponse } from "./fixtures";

// The sample output below is the documented SAM 3.1 example from the official
// @meta-sam/parser README: frame 320 x 334, two objects for one concept.
const SAMPLE = '<0f>0<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334|>'
  + "<|mask;x=0;y=0;data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>"
  + ',1<|box;x1=155;y1=228;x2=202;y2=254;w=320;h=334|>'
  + '<|mask;x=0;y=0;data=27,48,~!!!!J!0c[q=Pj_zs=*4C4(/./x#:/`S_GnD`=o3?X{emCgO$y@|>\n';

function samResponse(text: string, status = "completed") {
  return { id: "resp_sam_fixture", status, output: [{ type: "message", id: "msg_sam", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }] };
}
const image = { dataUrl: "data:image/png;base64,AAAA", width: 320, height: 334 };

beforeEach(() => vi.spyOn(console, "info").mockImplementation(() => undefined));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("concept preparation", () => {
  it("keeps short visible noun phrases and removes SAM token characters", () => {
    expect(normalizeConcept("  hand   holding food ")).toBe("hand holding food");
    expect(normalizeConcept("moon<|box;x1=1|>")).toBe("moon box x1=1");
    expect(normalizeConcept("https://example.com/hand")).toBeNull();
    expect(normalizeConcept("")).toBeNull();
    expect(normalizeConcept("x".repeat(80))).toBeNull();
  });

  it("groups findings that name one element and caps the number of concepts", () => {
    const grouped = conceptsFromFindings([
      { visualConcept: "Hand holding food" }, { visualConcept: null }, { visualConcept: "hand holding food" },
      { visualConcept: "crescent moon" }, { visualConcept: "tent" }, { visualConcept: "campfire" },
    ]);
    expect(grouped.concepts).toEqual([
      { concept: "Hand holding food", findingIndexes: [0, 2] },
      { concept: "crescent moon", findingIndexes: [3] },
      { concept: "tent", findingIndexes: [4] },
    ]);
    expect(grouped.dropped).toBe(1);
  });
});

describe("SAM 3.1 output", () => {
  it("parses the documented sample into boxes and masks in source pixels", async () => {
    const parsed = await parseSamOutput(samOutputText(samResponse(SAMPLE)));
    expect(samFrameSize(SAMPLE)).toEqual({ width: 320, height: 334 });
    const objects = objectsFromSamText(SAMPLE, parsed.records, { width: 320, height: 334 });
    expect(objects).toHaveLength(2);
    // The parser reports half-open bounds, so the inclusive x2=270 becomes 271.
    expect(objects.map((object) => object.box)).toEqual(expect.arrayContaining([
      { left: 211, top: 228, right: 271, bottom: 255 }, { left: 155, top: 228, right: 203, bottom: 255 },
    ]));
    for (const object of objects) {
      expect(object.mask).not.toBeNull();
      expect(object.mask!.path.startsWith("M")).toBe(true);
      expect(object.mask!.scaleX).toBe(1);
      expect(object.confidence).toBeNull();
    }
  });

  it("scales coordinates when the measured image differs from the SAM frame", async () => {
    const parsed = await parseSamOutput(SAMPLE);
    const [first] = objectsFromSamText(SAMPLE, parsed.records, { width: 640, height: 668 });
    expect(first!.box).toEqual({ left: 422, top: 456, right: 542, bottom: 510 });
    expect(first!.mask!.scaleX).toBe(2);
    expect(first!.mask!.x).toBe(422);
  });

  it("treats empty output as no detection", async () => {
    const parsed = await parseSamOutput(samOutputText(samResponse("")));
    expect(objectsFromSamText("", parsed.records, { width: 320, height: 334 })).toEqual([]);
  });

  it("rejects incomplete envelopes and refusals", () => {
    expect(() => samOutputText(samResponse(SAMPLE, "incomplete"))).toThrow();
    expect(() => samOutputText({ id: "r", status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] })).toThrow();
  });
});

describe("segmentation requests", () => {
  const base = { image, key: "test-key", signal: new AbortController().signal, deadline: Date.now() + 60_000 };

  it("sends one documented request per concept and reports found objects", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(samResponse(SAMPLE)));
    const outcome = await segmentConcept({ ...base, fetcher, concept: "button" });
    expect(outcome.status).toBe("found");
    expect(outcome.objects).toHaveLength(2);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.meta.ai/v1/responses");
    expect(init?.redirect).toBe("error");
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("sam-3.1");
    expect(body.input[0].content).toEqual([{ type: "input_text", text: "button" }, { type: "input_image", image_url: image.dataUrl }]);
    expect(body.metadata).toEqual({ include_confidence: "true" });
    expect(body.store).toBe(false);
  });

  it("reads a recorded live response with four separate matches and their confidence", async () => {
    // Recorded on 2026-11-04 from sam-3.1 for the concept "star" on an original 800 x 1000
    // test drawing made for this project. It is used here as a parser fixture only.
    const text = readFileSync("tests/data/sam-star-original-poster.txt", "utf8");
    const parsed = await parseSamOutput(text);
    const objects = objectsFromSamText(text, parsed.records, { width: 800, height: 1000 });
    expect(objects).toHaveLength(4);
    expect(objects.map((object) => object.confidence)).toEqual([...objects.map((object) => object.confidence)].sort((a, b) => b! - a!));
    expect(objects.every((object) => object.mask && object.confidence! > 0 && object.confidence! <= 1)).toBe(true);
    expect(objects[0]!.box).toEqual({ left: 553, top: 84, right: 579, bottom: 108 });
  });

  it("merges a detection reported twice but keeps distinct overlapping matches, up to six", async () => {
    const mask = "<|mask;x=0;y=0;data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>";
    const record = (id: number, x1: number, y1: number, c: number) => `${id}<|box;x1=${x1};y1=${y1};x2=${x1 + 59};y2=${y1 + 26};w=320;h=334;c=${c}|>${mask}`;
    // Records 0 and 1 are the same element shifted by one pixel (IoU near 0.9).
    // Record 2 overlaps record 0 by about a third and is a separate match.
    const twice = `<0f>${[record(0, 10, 10, 0.6), record(1, 11, 11, 0.9), record(2, 40, 20, 0.7)].join(",")}\n`;
    const objects = objectsFromSamText(twice, (await parseSamOutput(twice)).records, { width: 320, height: 334 });
    expect(objects.map((object) => [object.box.left, object.confidence])).toEqual([[11, 0.9], [40, 0.7]]);
    const many = `<0f>${Array.from({ length: 9 }, (_, index) => record(index, 10 + index * 30, 200, 0.5 + index / 100)).join(",")}\n`;
    expect(objectsFromSamText(many, (await parseSamOutput(many)).records, { width: 320, height: 334 })).toHaveLength(6);
  });

  it("reports provider failures without throwing, and skips work near the deadline", async () => {
    const failed = await segmentConcept({ ...base, concept: "hand", fetcher: vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("{}", { status: 400 })) });
    expect(failed).toMatchObject({ status: "failed", failure: "http", objects: [] });
    const fetcher = vi.fn<typeof fetch>();
    const skipped = await segmentConcept({ ...base, concept: "hand", fetcher, deadline: Date.now() + 1_000 });
    expect(skipped.status).toBe("skipped");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps a user cancellation as a cancellation", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => { controller.abort(); throw new DOMException("aborted", "AbortError"); });
    await expect(segmentConcept({ ...base, signal: controller.signal, concept: "hand", fetcher })).rejects.toThrow();
  });

  it("links regions only to the findings that named the element", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(samResponse(SAMPLE)))
      .mockResolvedValueOnce(new Response("{}", { status: 503 }));
    const { segmentation } = await segmentImage({ ...base, fetcher, findings: [
      { visualConcept: "button" }, { visualConcept: "crescent moon" }, { visualConcept: "Button" },
    ] });
    expect(segmentation.state).toBe("partial");
    expect(segmentation.regions).toHaveLength(2);
    expect(segmentation.regions.every((region) => region.findingIndexes.join() === "0,2" && region.matchesForConcept === 2)).toBe(true);
    expect(segmentation.concepts.map((item) => item.status)).toEqual(["found", "failed"]);
    expect(segmentation.image).toEqual({ width: 320, height: 334 });
  });
});

describe("review with an image", () => {
  const withImage: ReviewInput = { copy: "Night camping essentials", publicationDate: "2026-11-04", market: "KR", image: { mediaType: "image/png", ...image } };
  const visual = () => {
    const value = assessment(true, "Night camping");
    value.findings[0]!.visualConcept = "button";
    value.observations.push({ kind: "image", description: "Two buttons appear near the bottom." });
    return value;
  };
  const registryRetriever = async () => ({ state: "available" as const, checkedCases: 0, matchedCaseIds: [], evidence: [] });

  it("maps SAM regions onto assessed findings", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(researchResponse()))
      .mockResolvedValueOnce(Response.json(assessmentResponse(visual())))
      .mockResolvedValueOnce(Response.json(samResponse(SAMPLE)));
    const response = await reviewWithMeta(withImage, { apiKey: "test", fetcher, registryRetriever });
    expect(response.state).toBe("completed");
    if (response.state !== "completed") return;
    expect(resultSchema.safeParse(response.result).success).toBe(true);
    expect(response.result.findings[0]!.visualConcept).toBe("button");
    expect(response.result.segmentation).toMatchObject({ state: "completed", model: "sam-3.1", image: { width: 320, height: 334 } });
    expect(response.result.segmentation.regions.map((region) => region.findingIndexes)).toEqual([[0], [0]]);
    expect(response.result.limitations.join(" ")).toContain("A region does not establish meaning");
  });

  it("keeps the assessment and evidence when segmentation fails", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(researchResponse()))
      .mockResolvedValueOnce(Response.json(assessmentResponse(visual())))
      .mockResolvedValueOnce(new Response("{}", { status: 500 }));
    const response = await reviewWithMeta(withImage, { apiKey: "test", fetcher, registryRetriever });
    expect(response.state).toBe("completed");
    if (response.state !== "completed") return;
    expect(response.result.findings).toHaveLength(1);
    expect(response.result.sources).toHaveLength(1);
    expect(response.result.segmentation.state).toBe("failed");
    expect(response.result.segmentation.regions).toEqual([]);
  });

  it("drops visual concepts and never calls SAM for a copy only review", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(researchResponse()))
      .mockResolvedValueOnce(Response.json(assessmentResponse((() => { const value = assessment(true, "Night camping"); value.findings[0]!.visualConcept = "button"; return value; })())));
    const response = await reviewWithMeta({ copy: "Night camping essentials", publicationDate: "2026-11-04", market: "KR" }, { apiKey: "test", fetcher, registryRetriever });
    expect(fetcher).toHaveBeenCalledTimes(2);
    if (response.state !== "completed") throw new Error("Expected a completed review");
    expect(response.result.findings[0]!.visualConcept).toBeNull();
    expect(response.result.segmentation).toMatchObject({ state: "not_requested", reason: "no_image" });
  });
});
