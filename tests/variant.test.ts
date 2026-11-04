import { createHmac } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signContext, verifyContext, ContextError } from "@/server/evidence-context";
import { alignVariant, cleanInstruction, createVariant, editPrompt, localization, measurePreservation, requestEdit, transferImage } from "@/server/variant";
import { reviewWithMeta, variantContextFor, type EvidenceContext } from "@/server/meta";
import { REQUEST_BUDGET, variantRequestBytes } from "@/lib/transport";
import { ReviewError } from "@/server/review-error";
import { variantResponseSchema } from "@/lib/variant-contract";
import type { ReviewInput } from "@/lib/review-contract";
import { assessment, assessmentResponse, researchResponse } from "./fixtures";

// Synthetic images only. Every provider response below is a test fixture.
const W = 240, H = 300;
const box = { left: 30, top: 200, right: 110, bottom: 280 };
const evidence: EvidenceContext = {
  sources: [{ sourceId: "S1", title: "Synthetic source fixture", citedPassage: "A synthetic cited passage.", evidenceState: "unverified", host: "example.com" }],
  registry: { state: "available", checkedCases: 0, matchedCaseIds: [], evidence: [] },
};

async function png(paint: Array<{ left: number; top: number; width: number; height: number; color: string }> = []) {
  return sharp({ create: { width: W, height: H, channels: 3, background: "#1a3a4a" } })
    .composite(await Promise.all(paint.map(async (item) => ({
      input: await sharp({ create: { width: item.width, height: item.height, channels: 3, background: item.color } }).png().toBuffer(),
      left: item.left, top: item.top,
    })))).png().toBuffer();
}
const dataUrl = (bytes: Buffer) => `data:image/png;base64,${bytes.toString("base64")}`;
// The documented SAM 3.1 sample from the @meta-sam/parser README, measured on a 320 x 334 frame.
const SAM_SAMPLE = '<0f>0<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334|>'
  + "<|mask;x=0;y=0;data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>\n";
const samResponse = (text: string) => ({ id: "resp_sam", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }] });

beforeEach(() => vi.spyOn(console, "info").mockImplementation(() => undefined));
afterEach(() => vi.restoreAllMocks());

describe("signed evidence context", () => {
  const firstReview = { outcome: "emerging_signal" as const, findings: 1 };
  const base = { publicationDate: "2026-11-20", copy: "Night camping", imageDataUrl: "data:image/png;base64,AAAA", image: { width: W, height: H }, firstReview, evidence, regions: [{ id: "G1", concept: "hand", box }] };
  // Recomputes the server's signature so tests can build tokens the server would accept.
  const sign = (key: string, body: string) => createHmac("sha256", createHmac("sha256", key).update("narak.variant-context.v2").digest()).update(body).digest("base64url");

  it("round trips and binds the context to the same creative", () => {
    const token = signContext("key-one", base, 1_000)!;
    expect(verifyContext("key-one", token, base, 2_000).regions[0]!.id).toBe("G1");
    expect(() => verifyContext("key-one", token, { ...base, copy: "Different copy" }, 2_000)).toThrow(ContextError);
    expect(() => verifyContext("key-one", token, { ...base, publicationDate: "2026-11-21" }, 2_000)).toThrow(ContextError);
  });

  it("keeps each source host, so a variant reassessment applies the same reaction source checks", () => {
    const token = signContext("key-one", base, 1_000)!;
    expect(verifyContext("key-one", token, base, 2_000).evidence.sources.map((source) => source.host)).toEqual(["example.com"]);
  });

  it("rejects edited evidence, another key and an expired context", () => {
    const token = signContext("key-one", base, 1_000)!;
    const [body, signature] = token.split(".");
    const edited = JSON.parse(inflateRawSync(Buffer.from(body!, "base64url")).toString());
    edited.evidence.sources[0].citedPassage = "An added claim.";
    const editedBody = deflateRawSync(Buffer.from(JSON.stringify(edited))).toString("base64url");
    expect(() => verifyContext("key-one", `${editedBody}.${signature}`, base, 2_000)).toThrow(ContextError);
    expect(() => verifyContext("key-two", token, base, 2_000)).toThrow(ContextError);
    expect(() => verifyContext("key-one", token, base, 1_000 + 7 * 60 * 60 * 1000)).toThrow(ContextError);
  });

  it("compresses repetitive evidence and keeps the first review in the signed payload", () => {
    const passage = "A synthetic cited passage about a seasonal campaign and its reported reading. ".repeat(300);
    const many: EvidenceContext = { ...evidence, sources: Array.from({ length: 20 }, (_, index) => ({ ...evidence.sources[0]!, sourceId: `S${index + 1}`, citedPassage: passage.slice(0, 20_000) })) };
    const token = signContext("key-one", { ...base, evidence: many }, 1_000)!;
    const raw = Buffer.from(JSON.stringify(many)).toString("base64url").length;
    expect(token.length).toBeLessThan(raw / 20);
    expect(verifyContext("key-one", token, base, 2_000).firstReview).toEqual(firstReview);
  });

  it("caps decompression even for a correctly signed token", () => {
    const bomb = deflateRawSync(Buffer.from(`{"v":2,"pad":"${"a".repeat(6_000_000)}"}`)).toString("base64url");
    expect(bomb.length).toBeLessThan(20_000);
    expect(() => verifyContext("key-one", `${bomb}.${sign("key-one", bomb)}`, base, 2_000)).toThrow(ContextError);
  });
});

describe("variant request budget", () => {
  const segmentation = { state: "completed" as const, reason: null, model: "sam-3.1" as const, image: { width: W, height: H },
    concepts: [{ concept: "hand", findingIndexes: [0], status: "found" as const, regionIds: ["G1"] }],
    regions: [{ id: "G1", concept: "hand", findingIndexes: [0], box, mask: null, confidence: null, matchesForConcept: 1 }] };
  const image = { mediaType: "image/png" as const, dataUrl: "data:image/png;base64,AAAA", width: W, height: H };
  const first = { outcome: "emerging_signal" as const, findings: 1 };

  it("issues a context when the repeated upload, copy and token fit the request budget", () => {
    const issued = variantContextFor("k", { copy: "Night camping", publicationDate: "2026-11-20", market: "KR", image: { ...image, uploadBytes: 1_000_000 } }, segmentation, evidence, first);
    expect(issued.note).toBeNull();
    expect(variantRequestBytes({ uploadBytes: 1_000_000, copy: "Night camping", context: issued.token! })).toBeLessThan(REQUEST_BUDGET);
  });

  it("withholds the context and says why when the variant request would exceed the hosting limit", () => {
    const withheld = variantContextFor("k", { copy: "\uce74".repeat(5_000), publicationDate: "2026-11-20", market: "KR", image: { ...image, uploadBytes: 4 * 1024 * 1024 } },
      segmentation, { ...evidence, sources: Array.from({ length: 40 }, (_, index) => ({ ...evidence.sources[0]!, sourceId: `S${index + 1}`, citedPassage: Array.from({ length: 3_000 }, (_, n) => ((index * 7919 + n * 104729) % 1_000_003).toString(36)).join(" ") })) }, first);
    expect(withheld.token).toBeNull();
    expect(withheld.note).toContain("4.5 MB request limit");
  });

  it("issues nothing for a review without outlined regions", () => {
    expect(variantContextFor("k", { copy: "x", publicationDate: "2026-11-20", market: "KR", image }, { ...segmentation, regions: [] }, evidence, first)).toEqual({ token: null, note: null });
  });
});

describe("edit request", () => {
  it("cleans the instruction and names the element and its place", () => {
    expect(cleanInstruction("  replace\nwith a cup ")).toBe("replace with a cup");
    expect(cleanInstruction("x")).toBeNull();
    expect(cleanInstruction("y".repeat(201))).toBeNull();
    const prompt = editPrompt("hand", box, { width: W, height: H }, "replace the hand with a paper cup");
    expect(prompt).toContain("Edit only the hand in the lower left area");
    expect(prompt).toContain("replace the hand with a paper cup");
    expect(prompt).toContain("Keep every other part of the image exactly as it is");
  });

  it("sends the documented JSON edit body with search and shell tools off", async () => {
    const out = await png();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ created: 1, data: [{ b64_json: out.toString("base64") }] }));
    const bytes = await requestEdit({ prompt: "p", dataUrl: "data:image/png;base64,AAAA", size: { width: W, height: H }, key: "k", fetcher, signal: new AbortController().signal });
    expect(bytes.equals(out)).toBe(true);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.meta.ai/v1/images/edits");
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "muse-image-1.0", prompt: "p", images: [{ image_url: "data:image/png;base64,AAAA" }], n: 1, size: `${W}x${H}`, output_format: "png",
      tool_enablement: { enable_image_search: false, enable_web_search: false, enable_shell: false },
    });
  });

  it("maps a content policy block to its own issue", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ error: { type: "invalid_request_error", code: "content_policy_violation", param: "prompt" } }, { status: 400 }));
    const failure = await requestEdit({ prompt: "p", dataUrl: "d", size: { width: W, height: H }, key: "k", fetcher, signal: new AbortController().signal }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ReviewError);
    expect((failure as ReviewError).issue.code).toBe("content_policy");
  });

  it("maps documented server failures, rejected parameters and unreadable bodies to distinct issues", async () => {
    const attempt = (response: Response) => requestEdit({ prompt: "p", dataUrl: "d", size: { width: W, height: H }, key: "k",
      fetcher: vi.fn<typeof fetch>().mockResolvedValueOnce(response), signal: new AbortController().signal }).catch((error: unknown) => error);
    expect(await attempt(Response.json({ error: { type: "server_error" } }, { status: 503 }))).toMatchObject({ state: "unavailable", issue: { code: "provider_unavailable", retryable: true } });
    expect(await attempt(Response.json({ error: { type: "invalid_request_error", code: "unsupported_parameter", param: "mask" } }, { status: 400 }))).toMatchObject({ issue: { code: "unsupported_request", retryable: false } });
    expect(await attempt(new Response("<html>gateway</html>", { status: 502 }))).toMatchObject({ issue: { code: "provider_unavailable" } });
    expect(await attempt(Response.json({ data: [] }))).toMatchObject({ name: "ProviderOutputError" });
  });
});

describe("variant cancellation and timeouts", () => {
  it("reports a stop during the edit as cancelled and a provider failure without a comparison", async () => {
    const original = await png();
    const input: ReviewInput = { copy: "Night camping", publicationDate: "2026-11-20", market: "KR", image: { mediaType: "image/png", dataUrl: dataUrl(original), width: W, height: H } };
    const token = signContext("test", { publicationDate: input.publicationDate, copy: input.copy, imageDataUrl: input.image!.dataUrl, image: { width: W, height: H },
      firstReview: { outcome: "emerging_signal", findings: 1 }, evidence, regions: [{ id: "G1", concept: "hand", box }] })!;
    const stop = new AbortController();
    const hanging = vi.fn<typeof fetch>().mockImplementation((_, init) => new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      setTimeout(() => stop.abort(), 5);
    }));
    const cancelled = await createVariant({ input, context: token, regionId: "G1", instruction: "make it white" }, { apiKey: "test", fetcher: hanging, signal: stop.signal });
    expect(cancelled).toMatchObject({ state: "incomplete", result: null, issue: { code: "cancelled", retryable: true } });
    const unavailable = await createVariant({ input, context: token, regionId: "G1", instruction: "make it white" },
      { apiKey: "test", fetcher: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { type: "server_error" } }, { status: 503 })) });
    expect(unavailable).toMatchObject({ state: "unavailable", result: null, issue: { code: "provider_unavailable" } });
  });
});

describe("locating the edit", () => {
  // Box geometry recorded from the live SAM 3.1 "star" run on the original test drawing.
  const stars = [
    { left: 553, top: 84, right: 579, bottom: 108 }, { left: 727, top: 223, right: 745, bottom: 241 },
    { left: 583, top: 229, right: 597, bottom: 244 }, { left: 737, top: 75, right: 751, bottom: 89 },
  ];
  const size = { width: 800, height: 1000 };

  it("names how many matches exist and places the selected one by its box", () => {
    const prompt = editPrompt("star", stars[1]!, size, "remove this star", 3);
    expect(prompt).toContain("This image contains 4 separate star matches.");
    expect(prompt).toContain("Change only the star in the upper right area, inside the rectangle from 91% to 93% across and 22% to 24% down");
    expect(prompt).toContain("Leave the other 3 exactly as they are.");
    expect(editPrompt("star", stars[3]!, size, "remove this star", 3)).toContain("from 92% to 94% across and 8% to 9% down");
  });

  it("reports an edit that removed a different match than the selected one", () => {
    // The live variant kept the selected star and lost the top right one.
    const after = [stars[0]!, stars[1]!, stars[2]!];
    expect(localization(stars[1]!, [stars[0]!, stars[2]!, stars[3]!], after)).toEqual({ targetStillDetected: true, otherMatches: 3, otherMatchesMissing: 1 });
    expect(localization(stars[1]!, [stars[0]!, stars[2]!, stars[3]!], [stars[0]!, stars[2]!, stars[3]!])).toEqual({ targetStillDetected: false, otherMatches: 3, otherMatchesMissing: 0 });
    expect(localization(stars[1]!, [], null)).toEqual({ targetStillDetected: null, otherMatches: 0, otherMatchesMissing: null });
  });

  it("measures the change to a small element without the background hiding it", async () => {
    const small = { left: 200, top: 40, right: 212, bottom: 52 };
    const before = await png([{ left: 200, top: 40, width: 12, height: 12, color: "#f6e7b8" }]);
    const after = await png();
    const measured = await measurePreservation(before, after, small, { width: W, height: H });
    expect(measured.targetChanged).toBe(true);
    expect(measured.outsideChangedShare).toBe(0);
  });
});

describe("preservation measurement", () => {
  it("reports a change inside the target and none outside", async () => {
    const original = await png([{ left: 40, top: 210, width: 60, height: 60, color: "#e0b090" }]);
    const variant = await png([{ left: 40, top: 210, width: 60, height: 60, color: "#ffffff" }]);
    const measured = await measurePreservation(original, variant, box, { width: W, height: H });
    expect(measured.outsideChangedShare).toBe(0);
    expect(measured.insideChangedShare).toBeGreaterThan(0.15);
    expect(measured).toMatchObject({ material: false, targetChanged: true, changedCells: [] });
  });

  it("discloses material changes outside the target", async () => {
    const original = await png();
    const variant = await png([{ left: 120, top: 0, width: 120, height: 150, color: "#ff00ff" }]);
    const measured = await measurePreservation(original, variant, box, { width: W, height: H });
    expect(measured.material).toBe(true);
    expect(measured.targetChanged).toBe(false);
    expect(measured.changedCells.length).toBeGreaterThan(0);
    for (const cell of measured.changedCells) expect(cell.left).toBeGreaterThanOrEqual(108);
  });

  it("resizes a returned image onto the original grid and flags a shape change", async () => {
    const wide = await sharp({ create: { width: 300, height: 300, channels: 3, background: "#000" } }).png().toBuffer();
    const aligned = await alignVariant(wide, { width: W, height: H });
    expect(aligned).toMatchObject({ resized: true, aspectChanged: true, returned: { width: 300, height: 300 } });
    expect((await sharp(aligned.png).metadata()).width).toBe(W);
  });
});

describe("variant flow", () => {
  async function setup(firstReview: { outcome: "emerging_signal" | "no_supported_concern_found"; findings: number } = { outcome: "emerging_signal", findings: 1 }) {
    const original = await png([{ left: 40, top: 210, width: 60, height: 60, color: "#e0b090" }]);
    const variant = await png([{ left: 40, top: 210, width: 60, height: 60, color: "#ffffff" }]);
    const input: ReviewInput = { copy: "Night camping", publicationDate: "2026-11-20", market: "KR", image: { mediaType: "image/png", dataUrl: dataUrl(original), width: W, height: H } };
    const token = signContext("test", { publicationDate: input.publicationDate, copy: input.copy, imageDataUrl: input.image!.dataUrl, image: { width: W, height: H }, firstReview, evidence, regions: [{ id: "G1", concept: "hand", box }] })!;
    const visual = assessment(true, "Night camping"); visual.findings[0]!.visualConcept = "hand";
    visual.observations.push({ kind: "image", description: "A hand appears at the lower left." });
    const bodies: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push({ url: String(url), body });
      if (String(url).endsWith("/images/edits")) return Response.json({ data: [{ b64_json: variant.toString("base64") }] });
      if (body.model === "sam-3.1") return Response.json(samResponse(SAM_SAMPLE));
      return Response.json(assessmentResponse(body.input[0].content[1].image_url === input.image!.dataUrl ? visual : assessment(false)));
    });
    return { input, token, fetcher, bodies };
  }

  it("reassesses both versions with the signed evidence and reports measured preservation", async () => {
    const { input, token, fetcher, bodies } = await setup();
    const response = await createVariant({ input, context: token, regionId: "G1", instruction: "make the hand white" }, { apiKey: "test", fetcher });
    expect(variantResponseSchema.safeParse(response).success).toBe(true);
    if (response.state !== "completed") throw new Error(JSON.stringify(response.issue));
    const result = response.result;
    expect(result.original).toMatchObject({ state: "completed", outcome: "emerging_signal" });
    expect(result.variant).toMatchObject({ state: "completed", outcome: "no_supported_concern_found" });
    expect(result.preservation).toMatchObject({ material: false, targetChanged: true });
    expect(result.redetection).toMatchObject({ status: "found", targetStillDetected: false, otherMatches: 0, otherMatchesMissing: 0 });
    expect(result.notes[0]).toContain("synthetic image made by Muse Image");
    const assessments = bodies.filter((item) => item.body.model === "muse-spark-1.3");
    expect(assessments).toHaveLength(2);
    // Same passages and registry for both versions, only the image differs.
    const contexts = assessments.map((item) => JSON.parse((item.body.input as Array<{ content: Array<{ text: string }> }>)[0]!.content[0]!.text));
    expect(contexts[0].citedResearch).toEqual(contexts[1].citedResearch);
    expect(contexts[0].citedResearch[0].sourceId).toBe("S1");
    expect(assessments.every((item) => !("tools" in item.body))).toBe(true);
    // The variant reaches Muse Spark and SAM 3.1 as the lossless PNG at full size.
    const variantImages = bodies.filter((item) => item.body.model !== "muse-image-1.0" && !String(item.url).endsWith("/images/edits"))
      .map((item) => (item.body.input as Array<{ content: Array<{ image_url?: string }> }>)[0]!.content[1]!.image_url!)
      .filter((url) => url !== input.image!.dataUrl);
    expect(variantImages).toHaveLength(2);
    expect(variantImages.every((url) => url.startsWith("data:image/png;base64,"))).toBe(true);
    expect(result.transfer).toMatchObject({ format: "png", width: W, height: H });
    expect(result.firstReview).toEqual({ outcome: "emerging_signal", findings: 1 });
    expect(result.originalMatchesFirstReview).toBe(true);
    expect(result.notes.join(" ")).not.toContain("assessed differently");
  });

  it("flags when the unchanged original is assessed differently from its first review", async () => {
    const { input, token, fetcher } = await setup({ outcome: "no_supported_concern_found", findings: 0 });
    const response = await createVariant({ input, context: token, regionId: "G1", instruction: "make the hand white" }, { apiKey: "test", fetcher });
    if (response.state !== "completed") throw new Error("Expected a completed comparison");
    expect(response.result.originalMatchesFirstReview).toBe(false);
    expect(response.result.notes.join(" ")).toContain("cannot separate the effect of the edit");
  });

  it("refuses an aspect ratio Muse Image rejects without calling Meta", async () => {
    const { fetcher } = await setup();
    const strip = await sharp({ create: { width: 1700, height: 100, channels: 3, background: "#123" } }).png().toBuffer();
    const input: ReviewInput = { copy: "Night camping", publicationDate: "2026-11-20", market: "KR", image: { mediaType: "image/png", dataUrl: dataUrl(strip), width: 1700, height: 100 } };
    const token = signContext("test", { publicationDate: input.publicationDate, copy: input.copy, imageDataUrl: input.image!.dataUrl, image: { width: 1700, height: 100 },
      firstReview: { outcome: "emerging_signal", findings: 1 }, evidence, regions: [{ id: "G1", concept: "hand", box: { left: 10, top: 10, right: 60, bottom: 90 } }] })!;
    const response = await createVariant({ input, context: token, regionId: "G1", instruction: "make it white" }, { apiKey: "test", fetcher });
    expect(response).toMatchObject({ state: "failed", issue: { code: "invalid_input" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses an expired or mismatched context and an unknown region without calling Meta", async () => {
    const { input, token, fetcher } = await setup();
    const expired = await createVariant({ input, context: token, regionId: "G1", instruction: "make it white" }, { apiKey: "test", fetcher, now: Date.now() + 8 * 60 * 60 * 1000 });
    expect(expired).toMatchObject({ state: "failed", issue: { code: "context_expired" } });
    const changed = await createVariant({ input: { ...input, copy: "Edited copy" }, context: token, regionId: "G1", instruction: "make it white" }, { apiKey: "test", fetcher });
    expect(changed).toMatchObject({ state: "failed", issue: { code: "context_expired" } });
    const unknown = await createVariant({ input, context: token, regionId: "G9", instruction: "make it white" }, { apiKey: "test", fetcher });
    expect(unknown).toMatchObject({ state: "failed", issue: { code: "invalid_input" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps a comparison when one reassessment fails and labels it incomplete", async () => {
    const { input, token } = await setup();
    const variant = await png();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith("/images/edits")) return Response.json({ data: [{ b64_json: variant.toString("base64") }] });
      if (body.model === "sam-3.1") return Response.json(samResponse(""));
      if (body.input[0].content[1].image_url === input.image!.dataUrl) return Response.json(assessmentResponse(assessment(true, "Night camping")));
      return new Response("{}", { status: 500 });
    });
    const response = await createVariant({ input, context: token, regionId: "G1", instruction: "remove the hand" }, { apiKey: "test", fetcher });
    if (response.state !== "completed") throw new Error("Expected a completed comparison");
    expect(response.result.variant.state).toBe("failed");
    expect(response.result.redetection.status).toBe("not_found");
    expect(response.result.notes.join(" ")).toContain("this comparison is incomplete");
  });
});

describe("variant transfer", () => {
  it("keeps a small variant as PNG and reduces a large one to a JPEG that fits", async () => {
    const small = await png();
    expect(await transferImage(small, { width: W, height: H })).toMatchObject({ format: "png", width: W, height: H });
    let seed = 0x9e3779b9;
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % 256; };
    const noise = await sharp(Buffer.from(Array.from({ length: 900 * 900 * 3 }, random)), { raw: { width: 900, height: 900, channels: 3 } }).png().toBuffer();
    expect(noise.byteLength).toBeGreaterThan(2_000_000);
    const jpegOnly = await transferImage(noise, { width: 900, height: 900 }, 700_000);
    expect(jpegOnly).toMatchObject({ format: "jpeg", width: 900, height: 900 });
    const fitted = await transferImage(noise, { width: 900, height: 900 }, 250_000);
    expect(fitted.format).toBe("jpeg");
    expect(fitted.bytes.byteLength).toBeLessThanOrEqual(250_000);
    expect(fitted).toMatchObject({ width: 675, height: 675 });
    // Below a 512 pixel long side the copy would be too small to compare, so it stops.
    await expect(transferImage(noise, { width: 900, height: 900 }, 50_000)).rejects.toThrow("too large to transfer");
  });
});

describe("review result", () => {
  it("carries a signed context only when an image has outlined regions", async () => {
    const original = await png([{ left: 40, top: 210, width: 60, height: 60, color: "#e0b090" }]);
    const input: ReviewInput = { copy: "Night camping", publicationDate: "2026-11-20", market: "KR", image: { mediaType: "image/png", dataUrl: dataUrl(original), width: W, height: H } };
    const visual = assessment(true, "Night camping"); visual.findings[0]!.visualConcept = "hand";
    visual.observations.push({ kind: "image", description: "A hand appears at the lower left." });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(researchResponse()))
      .mockResolvedValueOnce(Response.json(assessmentResponse(visual)))
      .mockResolvedValueOnce(Response.json(samResponse(SAM_SAMPLE)));
    const registryRetriever = async () => ({ state: "available" as const, checkedCases: 0, matchedCaseIds: [], evidence: [] });
    const response = await reviewWithMeta(input, { apiKey: "test", fetcher, registryRetriever });
    if (response.state !== "completed") throw new Error("Expected a completed review");
    const token = response.result.variantContext!;
    const context = verifyContext("test", token, { publicationDate: input.publicationDate, copy: input.copy, imageDataUrl: input.image!.dataUrl });
    expect(context.evidence.sources.map((source) => source.sourceId)).toEqual(["S1"]);
    // The sample box (211, 228) to (271, 255) on 320 x 334 scales onto the 240 x 300 image.
    expect(context.regions).toEqual([{ id: "G1", concept: "hand", box: { left: 158, top: 205, right: 203, bottom: 229 } }]);
    const copyOnly = await reviewWithMeta({ copy: "Night camping", publicationDate: "2026-11-20", market: "KR" }, {
      apiKey: "test", registryRetriever,
      fetcher: vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(researchResponse())).mockResolvedValueOnce(Response.json(assessmentResponse())),
    });
    if (copyOnly.state !== "completed") throw new Error("Expected a completed review");
    expect(copyOnly.result.variantContext).toBeNull();
  });
});
