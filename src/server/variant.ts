import "server-only";
import sharp from "sharp";
import { z } from "zod";
import { MAX_IMAGE_PIXELS, type ReviewInput } from "@/lib/review-contract";
import {
  MAX_EDIT_ASPECT_RATIO, MAX_INSTRUCTION_LENGTH, VARIANT_TIMEOUT_MS, variantResultSchema,
  type Reassessment, type VariantResponse, type VariantResult,
} from "@/lib/variant-contract";
import { getModelApiKey, META_IMAGE_EDITS_URL, MUSE_IMAGE_MODEL } from "./config";
import { ProviderOutputError } from "./bounded-read";
import { ContextError, verifyContext, type SignedContext } from "./evidence-context";
import { assessCreative } from "./meta";
import { ReviewError, invalidInput } from "./review-error";
import { createReviewDiagnostics } from "./review-diagnostics";
import { intersectionOverUnion, normalizeConcept, segmentConcept } from "./segmentation";

// Documentation: https://dev.meta.ai/docs/image-generation (POST /v1/images/edits).
// The endpoint has no mask parameter, so the edit is targeted through the prompt and
// preservation is measured afterwards instead of assumed.
const EDIT_TIMEOUT_MS = 100_000;
const MAX_EDIT_RESPONSE_BYTES = 40_000_000;
const COMPARE_LONG_SIDE = 480;
const CELL = 12;
const CHANGE_THRESHOLD = 18;
const MATERIAL_OUTSIDE_SHARE = 0.05;
const TARGET_CHANGED_SHARE = 0.15;
// The reply must stay under the 4.5 MB hosting limit after base64, next to the findings.
// A variant travels as PNG when it fits, otherwise as JPEG, reduced only if still too large.
const MAX_PNG_TRANSFER_BYTES = 2_500_000;
const MAX_TRANSFER_BYTES = 2_600_000;
const MIN_TRANSFER_LONG_SIDE = 512;

type Box = SignedContext["regions"][number]["box"];
type Size = { width: number; height: number };

export function cleanInstruction(value: string): string | null {
  const text = value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return text.length >= 3 && text.length <= MAX_INSTRUCTION_LENGTH ? text : null;
}

function position(box: Box, image: Size) {
  const cx = (box.left + box.right) / 2 / image.width, cy = (box.top + box.bottom) / 2 / image.height;
  const vertical = cy < 1 / 3 ? "upper" : cy > 2 / 3 ? "lower" : "middle";
  const horizontal = cx < 1 / 3 ? "left" : cx > 2 / 3 ? "right" : "center";
  return vertical === "middle" && horizontal === "center" ? "center" : `${vertical} ${horizontal}`.replace("middle ", "");
}

// Muse Image has no mask, so the prompt places the element in words and numbers. When SAM
// 3.1 found several matches, it says how many there are and which one to change.
export function editPrompt(concept: string, box: Box, image: Size, instruction: string, otherMatches = 0) {
  const percent = (value: number, total: number) => Math.round((value / total) * 100);
  const where = `the ${concept} in the ${position(box, image)} area, inside the rectangle from ${percent(box.left, image.width)}% to ${percent(box.right, image.width)}% across `
    + `and ${percent(box.top, image.height)}% to ${percent(box.bottom, image.height)}% down from the top left corner`;
  const others = otherMatches > 0
    ? `This image contains ${otherMatches + 1} separate ${concept} matches. Change only ${where}. Leave the other ${otherMatches} exactly as they are. `
    : `Edit only ${where}. `;
  return `${others}Requested change: ${instruction}. `
    + "Keep every other part of the image exactly as it is, including all text, people, objects, colors, layout, framing, lighting and illustration style. "
    + "Do not add text, logos or new elements anywhere else.";
}

// Compares SAM 3.1 matches before and after the edit. A match counts as the same element
// when the boxes overlap with an IoU above one half, an uncalibrated threshold.
export function localization(target: Box, others: Box[], redetected: Box[] | null) {
  if (!redetected) return { targetStillDetected: null, otherMatches: others.length, otherMatchesMissing: null };
  const present = (box: Box) => redetected.some((found) => intersectionOverUnion(found, box) > 0.5);
  return { targetStillDetected: present(target), otherMatches: others.length, otherMatchesMissing: others.filter((box) => !present(box)).length };
}

const editResponseSchema = z.object({
  data: z.array(z.object({ b64_json: z.string().min(16).max(MAX_EDIT_RESPONSE_BYTES) }).passthrough()).min(1),
}).passthrough();
const errorSchema = z.object({ error: z.object({ type: z.string().optional(), code: z.string().optional(), param: z.string().nullable().optional() }).passthrough() }).passthrough();

function editError(status: number, code?: string): ReviewError {
  if (code === "content_policy_violation") return new ReviewError("failed", {
    code: "content_policy", message: "Muse Image declined this change under its content policy. Try describing a different change.", retryable: false,
  }, 422);
  if (status === 401 || status === 403) return new ReviewError("unavailable", {
    code: "authentication", message: "The image service could not authenticate. The workspace owner needs to check the Meta API credentials and access.", retryable: false,
  }, 503);
  if (status === 429) return new ReviewError("unavailable", {
    code: "rate_limit", message: "The image service has reached its request limit. Please wait and try again.", retryable: true,
  }, 429);
  if (status === 400 || status === 404 || status === 422) return new ReviewError("unavailable", {
    code: "unsupported_request", message: "Muse Image did not accept this edit request. The integration needs to be checked.", retryable: false,
  }, 503);
  return new ReviewError("unavailable", {
    code: "provider_unavailable", message: "The image service is temporarily unavailable. Please try again later.", retryable: true,
  }, 503);
}

async function readCapped(response: Response, signal: AbortSignal, limit: number) {
  if (!response.body) throw new ProviderOutputError("Empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new ProviderOutputError("Response too large");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function requestEdit(options: { prompt: string; dataUrl: string; size: Size; key: string; fetcher: typeof fetch; signal: AbortSignal }) {
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(EDIT_TIMEOUT_MS)]);
  const response = await options.fetcher(META_IMAGE_EDITS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${options.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MUSE_IMAGE_MODEL, prompt: options.prompt, images: [{ image_url: options.dataUrl }], n: 1,
      size: `${options.size.width}x${options.size.height}`, output_format: "png",
      // A variant tests one visual change. Search and shell tools stay off.
      tool_enablement: { enable_image_search: false, enable_web_search: false, enable_shell: false },
    }),
    cache: "no-store",
    redirect: "error",
    signal,
  });
  const text = await readCapped(response, signal, response.ok ? MAX_EDIT_RESPONSE_BYTES : 64_000);
  if (!response.ok) {
    let code: string | undefined;
    try { const parsed = errorSchema.safeParse(JSON.parse(text)); code = parsed.success ? parsed.data.error.code ?? parsed.data.error.type : undefined; } catch { code = undefined; }
    throw editError(response.status, code);
  }
  let parsed;
  try { parsed = editResponseSchema.parse(JSON.parse(text)); } catch { throw new ProviderOutputError("Unusable edit response"); }
  return Buffer.from(parsed.data[0]!.b64_json, "base64");
}

// Decode the returned image and bring it onto the original's pixel grid, so regions,
// the comparison slider and the pixel measurement all share one coordinate space.
export async function alignVariant(bytes: Buffer, original: Size) {
  const decoded = sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: "warning" });
  const metadata = await decoded.metadata();
  if (!metadata.width || !metadata.height || !["png", "webp", "jpeg"].includes(metadata.format ?? "")) {
    throw new ProviderOutputError("Unreadable variant image");
  }
  const returned = { width: metadata.width, height: metadata.height };
  const same = returned.width === original.width && returned.height === original.height;
  const png = same && metadata.format === "png" ? bytes
    : await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS }).resize(original.width, original.height, { fit: "fill" }).png().toBuffer();
  const aspectChanged = Math.abs(returned.width / returned.height - original.width / original.height) > 0.01;
  return { png, returned, resized: !same, aspectChanged };
}

// Compare the two images at a reduced size in cells. A cell counts as changed when its mean
// channel difference passes a fixed threshold. The target is the region box with a margin.
export async function measurePreservation(original: Buffer, variant: Buffer, box: Box, size: Size) {
  const scale = Math.min(1, COMPARE_LONG_SIDE / Math.max(size.width, size.height));
  const width = Math.max(CELL, Math.round(size.width * scale)), height = Math.max(CELL, Math.round(size.height * scale));
  const read = (bytes: Buffer) => sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS }).resize(width, height, { fit: "fill" })
    .removeAlpha().toColourspace("srgb").raw().toBuffer();
  const [a, b] = await Promise.all([read(original), read(variant)]);
  // A margin absorbs small shifts. For a small element it scales with the element, so the
  // surrounding background cannot hide a change to the element itself.
  const boxSide = Math.max(box.right - box.left, box.bottom - box.top) * scale;
  const margin = Math.round(Math.min(Math.max(width, height) * 0.04, Math.max(CELL / 2, boxSide * 0.25)));
  const target = {
    left: box.left * scale - margin, top: box.top * scale - margin,
    right: box.right * scale + margin, bottom: box.bottom * scale + margin,
  };
  const columns = Math.ceil(width / CELL), rows = Math.ceil(height / CELL);
  let inside = 0, insideChanged = 0, outside = 0, outsideChanged = 0;
  const changedCells: Array<{ left: number; top: number; right: number; bottom: number }> = [];
  for (let row = 0; row < rows; row++) {
    let run = null as { start: number; end: number } | null;
    const flush = () => {
      if (!run) return;
      changedCells.push({
        left: Math.floor((run.start * CELL) / scale), top: Math.floor((row * CELL) / scale),
        right: Math.min(size.width, Math.ceil((run.end * CELL) / scale)), bottom: Math.min(size.height, Math.ceil(Math.min(height, (row + 1) * CELL) / scale)),
      });
      run = null;
    };
    for (let column = 0; column < columns; column++) {
      const x0 = column * CELL, y0 = row * CELL, x1 = Math.min(width, x0 + CELL), y1 = Math.min(height, y0 + CELL);
      let total = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const index = (y * width + x) * 3;
        total += Math.abs(a[index]! - b[index]!) + Math.abs(a[index + 1]! - b[index + 1]!) + Math.abs(a[index + 2]! - b[index + 2]!);
      }
      const changed = total / ((x1 - x0) * (y1 - y0) * 3) > CHANGE_THRESHOLD;
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const inTarget = cx >= target.left && cx <= target.right && cy >= target.top && cy <= target.bottom;
      if (inTarget) { inside++; if (changed) insideChanged++; flush(); continue; }
      outside++;
      if (changed) { outsideChanged++; run = run ? { ...run, end: column + 1 } : { start: column, end: column + 1 }; } else flush();
    }
    flush();
  }
  const outsideChangedShare = outside ? outsideChanged / outside : 0;
  const insideChangedShare = inside ? insideChanged / inside : 0;
  return {
    outsideChangedShare: Math.round(outsideChangedShare * 1000) / 1000,
    insideChangedShare: Math.round(insideChangedShare * 1000) / 1000,
    changedCells: changedCells.slice(0, 800), cellsTruncated: changedCells.length > 800,
    material: outsideChangedShare > MATERIAL_OUTSIDE_SHARE, targetChanged: insideChangedShare >= TARGET_CHANGED_SHARE,
  };
}

// The browser copy of the variant. Model calls and the pixel measurement always use the
// lossless PNG at full size, so a transfer format can never change an assessment.
export async function transferImage(png: Buffer, size: Size, maxBytes = MAX_TRANSFER_BYTES) {
  if (png.byteLength <= Math.min(MAX_PNG_TRANSFER_BYTES, maxBytes)) {
    return { bytes: png, format: "png" as const, width: size.width, height: size.height };
  }
  let width = size.width, height = size.height;
  while (true) {
    for (const quality of [90, 80, 70]) {
      const jpeg = await sharp(png, { limitInputPixels: MAX_IMAGE_PIXELS }).resize(width, height, { fit: "fill" }).jpeg({ quality }).toBuffer();
      if (jpeg.byteLength <= maxBytes) return { bytes: jpeg, format: "jpeg" as const, width, height };
    }
    if (Math.max(width, height) * 0.75 < MIN_TRANSFER_LONG_SIDE) throw new ProviderOutputError("Variant too large to transfer");
    width = Math.max(1, Math.round(width * 0.75)); height = Math.max(1, Math.round(height * 0.75));
  }
}

const failed = (error: ReviewError): VariantResponse => ({ state: error.state, result: null, issue: error.issue });

export interface VariantRequest { input: ReviewInput; context: string; regionId: string; instruction: string }
export interface VariantOptions { apiKey?: string; fetcher?: typeof fetch; signal?: AbortSignal; now?: number }

export async function createVariant(request: VariantRequest, options: VariantOptions = {}): Promise<VariantResponse> {
  const key = options.apiKey ?? getModelApiKey();
  if (!key) return failed(new ReviewError("unavailable", {
    code: "missing_credentials", message: "Live review is not configured in this workspace. No variant was made.", retryable: false,
  }, 503));
  const supplied = request.input.image;
  if (!supplied?.width || !supplied.height) return failed(invalidInput("A variant needs the poster image from the review.", "image"));
  const image: NonNullable<ReviewInput["image"]> & { width: number; height: number } = { ...supplied, width: supplied.width, height: supplied.height };
  const instruction = cleanInstruction(request.instruction);
  if (!instruction) return failed(invalidInput(`Describe the change in 3 to ${MAX_INSTRUCTION_LENGTH} characters.`));
  let context: SignedContext;
  try {
    context = verifyContext(key, request.context, { publicationDate: request.input.publicationDate, copy: request.input.copy, imageDataUrl: image.dataUrl }, options.now);
  } catch (error) {
    if (!(error instanceof ContextError)) throw error;
    return failed(new ReviewError("failed", {
      code: "context_expired", message: "This review has expired or no longer matches the creative. Run the review again, then test a variant.", retryable: false,
    }, 409));
  }
  const region = context.regions.find((item) => item.id === request.regionId);
  const concept = region && normalizeConcept(region.concept);
  if (!region || !concept) return failed(invalidInput("Select an outlined element on the poster to test a variant."));

  const size = { width: image.width, height: image.height };
  if (Math.max(size.width / size.height, size.height / size.width) > MAX_EDIT_ASPECT_RATIO) {
    return failed(invalidInput("Muse Image accepts images up to 16 times wider than tall, or taller than wide. This poster is outside that range, so no variant can be made."));
  }
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Variant timed out", "TimeoutError")), VARIANT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const deadline = Date.now() + VARIANT_TIMEOUT_MS - 3_000;
  try {
    const siblings = context.regions.filter((item) => item.id !== region.id && normalizeConcept(item.concept)?.toLowerCase() === concept.toLowerCase());
    const generated = await requestEdit({ prompt: editPrompt(concept, region.box, size, instruction, siblings.length), dataUrl: image.dataUrl, size, key, fetcher, signal });
    const aligned = await alignVariant(generated, size);
    const transfer = await transferImage(aligned.png, size);
    const variantDataUrl = `data:image/${transfer.format};base64,${transfer.bytes.toString("base64")}`;
    const modelDataUrl = `data:image/png;base64,${aligned.png.toString("base64")}`;
    const originalBytes = Buffer.from(image.dataUrl.slice(image.dataUrl.indexOf(",") + 1), "base64");
    const preservation = await measurePreservation(originalBytes, aligned.png, region.box, size);

    // Both versions get the same cited passages, registry notes and date in one round,
    // so a difference cannot come from new evidence or from a different instruction.
    const quiet = () => createReviewDiagnostics(() => undefined);
    const reassess = async (dataUrl: string): Promise<Reassessment> => {
      try {
        const { assessment, hasFindings, notes: scopeNoteList } = await assessCreative(
          { ...request.input, image: { ...image, mediaType: dataUrl === image.dataUrl ? image.mediaType : "image/png", dataUrl } },
          context.evidence, { key, signal, fetcher, diagnostics: quiet() },
        );
        return {
          state: "completed", outcome: hasFindings ? "emerging_signal" : "no_supported_concern_found",
          findings: assessment.findings.map((finding) => ({ ...finding, visualConcept: normalizeConcept(finding.visualConcept) })),
          evidenceScope: assessment.evidenceScope, limitations: [...scopeNoteList, ...assessment.limitations].slice(0, 8),
        };
      } catch (error) {
        if (options.signal?.aborted) throw error;
        return { state: "failed", message: error instanceof ReviewError ? error.issue.message : "The assessment did not finish for this version." };
      }
    };
    const [original, variant, redetected] = await Promise.all([
      reassess(image.dataUrl), reassess(modelDataUrl),
      segmentConcept({ image: { dataUrl: modelDataUrl, ...size }, concept, key, fetcher, signal, deadline }),
    ]);
    const located = localization(region.box, siblings.map((item) => item.box),
      redetected.status === "found" || redetected.status === "not_found" ? redetected.objects.map((object) => object.box) : null);
    const originalMatchesFirstReview = original.state === "completed"
      ? original.outcome === context.firstReview.outcome && original.findings.length === context.firstReview.findings : null;
    const notes = [
      "The variant is a synthetic image made by Muse Image for this comparison. It was not part of the submitted creative.",
      "A variant shows how this assessment responds to one edit. It does not establish history, intent or cause.",
      "Both versions were reassessed now with the same cited passages, registry notes and date. Two runs can differ even for identical images.",
      ...(originalMatchesFirstReview === false ? [`The unchanged original was assessed differently this time (${original.state === "completed" ? `${original.findings.length} ${original.findings.length === 1 ? "finding" : "findings"}` : ""}, against ${context.firstReview.findings} in the first review). This comparison cannot separate the effect of the edit from that run-to-run difference.`] : []),
      ...(preservation.material ? [`About ${Math.round(preservation.outsideChangedShare * 100)}% of the area outside the selected element also changed. Differences in the assessment may come from those changes.`] : []),
      ...(located.otherMatchesMissing ? [`SAM 3.1 no longer finds ${located.otherMatchesMissing} of the ${located.otherMatches} other ${concept} matches outside the selected area, so the edit may have changed a different element.`] : []),
      ...(!preservation.targetChanged ? ["The selected element changed little in the pixel comparison, so the edit may not have taken effect."] : []),
      ...(aligned.resized ? [`Muse Image returned ${aligned.returned.width} by ${aligned.returned.height} pixels. The variant was resized to the original size for this comparison${aligned.aspectChanged ? ", which also changed its proportions" : ""}.`] : []),
      ...(original.state === "failed" || variant.state === "failed" ? ["One reassessment did not finish, so this comparison is incomplete."] : []),
      ...(transfer.format === "jpeg" ? [`The variant is large, so the copy shown here is a JPEG${transfer.width !== size.width ? ` at ${transfer.width} by ${transfer.height} pixels` : ""}. The reassessment, the SAM 3.1 check and the pixel measurement used the lossless image at full size.`] : []),
    ];
    const result: VariantResult = variantResultSchema.parse({
      model: MUSE_IMAGE_MODEL,
      image: { dataUrl: variantDataUrl, ...size },
      transfer: { format: transfer.format, width: transfer.width, height: transfer.height, bytes: transfer.bytes.byteLength },
      returnedSize: aligned.returned,
      firstReview: context.firstReview,
      originalMatchesFirstReview,
      target: { regionId: region.id, concept, box: region.box },
      instruction,
      preservation,
      redetection: { status: redetected.status, regions: redetected.objects.map(({ box, mask }) => ({ box, mask })), ...located },
      original, variant, notes,
    });
    return { state: "completed", result };
  } catch (error) {
    if (error instanceof ReviewError) return { state: error.state, result: null, issue: error.issue };
    if (signal.aborted || (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name))) {
      return { state: "incomplete", result: null, issue: {
        code: options.signal?.aborted ? "cancelled" : "timeout", message: "The variant stopped before it finished. Nothing was compared. Please try again.", retryable: true,
      } };
    }
    return { state: "failed", result: null, issue: {
      code: "invalid_response", message: "Muse Image returned an image that could not be used. Nothing was compared. Please try again.", retryable: true,
    } };
  } finally {
    clearTimeout(timer);
  }
}
