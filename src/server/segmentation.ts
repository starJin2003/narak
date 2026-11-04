import "server-only";
import { decodeMaskToSVGPath, parseImageStream, recordsOfKind } from "@meta-sam/parser";
import { z } from "zod";
import {
  VISUAL_CONCEPT_MAX, notRequestedSegmentation, segmentationSchema,
  type Region, type Segmentation,
} from "@/lib/review-contract";
import { META_RESPONSES_URL, SAM_MODEL } from "./config";
import { ProviderHttpError, readBoundedJson } from "./bounded-read";

// Documentation: https://dev.meta.ai/docs/sam/overview and the official
// @meta-sam/parser package (SAM License, shipped with the package).
export const MAX_CONCEPTS = 3;
const MAX_REGIONS_PER_CONCEPT = 6;
const MAX_SAM_RESPONSE_BYTES = 6_000_000;
const MAX_MASK_PATH = 150_000;
const SAM_TIMEOUT_MS = 45_000;
const MIN_TIME_FOR_SEGMENTATION_MS = 8_000;
// Two boxes this similar are one detection reported twice. An uncalibrated heuristic,
// chosen so a one-pixel shift of the same element never reads as a second match.
export const DUPLICATE_IOU = 0.7;

export type SegmentationFailure = "http" | "timeout" | "output";

// Keep a concept to a short noun phrase. Characters used by SAM's token format
// are removed, so model text cannot introduce box or mask markup.
export function normalizeConcept(value: string | null | undefined): string | null {
  if (!value) return null;
  const concept = value.normalize("NFKC").replace(/[\u0000-\u001f<>|;~]/g, " ").replace(/\s+/g, " ").trim();
  if (concept.length < 2 || concept.length > VISUAL_CONCEPT_MAX || /https?:|www\./i.test(concept)) return null;
  return concept;
}

// Group findings by the visible element they name. A region is later linked only
// to the findings whose assessment named that element.
export function conceptsFromFindings(findings: ReadonlyArray<{ visualConcept: string | null }>) {
  const byKey = new Map<string, { concept: string; findingIndexes: number[] }>();
  let dropped = 0;
  findings.forEach((finding, index) => {
    const concept = normalizeConcept(finding.visualConcept);
    if (!concept) return;
    const key = concept.toLowerCase();
    const existing = byKey.get(key);
    if (existing) existing.findingIndexes.push(index);
    else if (byKey.size < MAX_CONCEPTS) byKey.set(key, { concept, findingIndexes: [index] });
    else dropped += 1;
  });
  return { concepts: [...byKey.values()], dropped };
}

const envelopeSchema = z.object({ id: z.string(), status: z.string(), output: z.array(z.unknown()).max(50) }).passthrough();
const messageSchema = z.object({ type: z.literal("message"), content: z.array(z.unknown()).max(50) }).passthrough();
const textPartSchema = z.object({ type: z.literal("output_text"), text: z.string().max(MAX_SAM_RESPONSE_BYTES) }).passthrough();

class SegmentationOutputError extends Error {}

export function samOutputText(raw: unknown): string {
  const envelope = envelopeSchema.safeParse(raw);
  if (!envelope.success || envelope.data.status !== "completed") throw new SegmentationOutputError("Unusable SAM response");
  let text = "";
  for (const item of envelope.data.output) {
    const message = messageSchema.safeParse(item);
    if (!message.success) continue;
    for (const part of message.data.content) {
      if (typeof part === "object" && part !== null && (part as { type?: unknown }).type === "refusal") {
        throw new SegmentationOutputError("SAM refused the request");
      }
      const block = textPartSchema.safeParse(part);
      if (block.success) text += block.data.text;
    }
  }
  return text;
}

// The official parser reads Responses API events. A non-streaming response is
// replayed as the documented delta, done and completed events.
export async function parseSamOutput(text: string) {
  async function* events() {
    if (text) yield { type: "response.output_text.delta", item_id: "sam", output_index: 0, content_index: 0, delta: text } as const;
    yield { type: "response.output_text.done", item_id: "sam", output_index: 0, content_index: 0, text } as const;
    yield { type: "response.completed" } as const;
  }
  const parsed = parseImageStream(events());
  for await (const snapshot of parsed) void snapshot;
  const result = await parsed.finalResult;
  if (result.outcome.status !== "completed") throw new SegmentationOutputError("SAM output ended early");
  return result;
}

// Box tokens carry the frame size SAM measured as w and h. Coordinates are scaled
// from that frame to the image the server measured.
export function samFrameSize(text: string): { width: number; height: number } | null {
  const token = /<\|box;([^|>]*)\|>/.exec(text);
  if (!token) return null;
  const fields = Object.fromEntries(token[1]!.split(";").map((pair) => pair.split("=")));
  const width = Number(fields.w), height = Number(fields.h);
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 ? { width, height } : null;
}

type DetectedObject = Omit<Region, "id" | "concept" | "findingIndexes" | "matchesForConcept">;

export function intersectionOverUnion(a: DetectedObject["box"], b: DetectedObject["box"]) {
  const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const overlap = width * height;
  const area = (box: typeof a) => (box.right - box.left) * (box.bottom - box.top);
  return overlap / Math.max(1, area(a) + area(b) - overlap);
}

export function objectsFromSamText(text: string, records: Awaited<ReturnType<typeof parseSamOutput>>["records"], image: { width: number; height: number }): DetectedObject[] {
  const frame = samFrameSize(text) ?? image;
  const scaleX = image.width / frame.width, scaleY = image.height / frame.height;
  const clampX = (value: number) => Math.min(image.width, Math.max(0, Math.round(value * scaleX)));
  const clampY = (value: number) => Math.min(image.height, Math.max(0, Math.round(value * scaleY)));
  const byObject = new Map<string, { box?: ReturnType<typeof recordsOfKind<"box">>[number]; mask?: ReturnType<typeof recordsOfKind<"mask">>[number] }>();
  for (const box of recordsOfKind(records, "box")) byObject.set(box.objectId, { ...byObject.get(box.objectId), box });
  for (const mask of recordsOfKind(records, "mask")) byObject.set(mask.objectId, { ...byObject.get(mask.objectId), mask });
  const objects: DetectedObject[] = [];
  for (const { box, mask } of byObject.values()) {
    const bounds = mask?.bounds ?? box;
    if (!bounds) continue;
    const region = { left: clampX(bounds.left), top: clampY(bounds.top), right: clampX(bounds.right), bottom: clampY(bounds.bottom) };
    if (region.right <= region.left || region.bottom <= region.top) continue;
    let maskShape: DetectedObject["mask"] = null;
    if (mask && mask.mask.width > 0 && mask.mask.height > 0) {
      try {
        const path = decodeMaskToSVGPath(mask.mask);
        if (path && path.length <= MAX_MASK_PATH) {
          maskShape = {
            path, x: clampX(mask.bounds.left), y: clampY(mask.bounds.top),
            scaleX: ((mask.bounds.right - mask.bounds.left) / mask.mask.width) * scaleX,
            scaleY: ((mask.bounds.bottom - mask.bounds.top) / mask.mask.height) * scaleY,
          };
        }
      } catch { maskShape = null; }
    }
    const confidence = mask?.confidence ?? box?.confidence;
    objects.push({ box: region, mask: maskShape, confidence: typeof confidence === "number" ? confidence : null });
  }
  objects.sort((a, b) => (b.confidence ?? -1) - (a.confidence ?? -1)
    || (b.box.right - b.box.left) * (b.box.bottom - b.box.top) - (a.box.right - a.box.left) * (a.box.bottom - a.box.top));
  const kept: DetectedObject[] = [];
  for (const object of objects) {
    if (kept.length >= MAX_REGIONS_PER_CONCEPT) break;
    if (!kept.some((other) => intersectionOverUnion(other.box, object.box) > DUPLICATE_IOU)) kept.push(object);
  }
  return kept;
}

export interface SegmentOptions {
  image: { dataUrl: string; width?: number; height?: number };
  concept: string;
  key: string;
  fetcher: typeof fetch;
  signal: AbortSignal;
  deadline: number;
}

export async function segmentConcept(options: SegmentOptions): Promise<{ status: "found" | "not_found" | "failed" | "skipped"; objects: DetectedObject[]; failure?: SegmentationFailure; frame?: { width: number; height: number } }> {
  const remaining = options.deadline - Date.now();
  if (remaining < MIN_TIME_FOR_SEGMENTATION_MS) return { status: "skipped", objects: [] };
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(Math.min(SAM_TIMEOUT_MS, remaining - 2_000))]);
  try {
    const response = await options.fetcher(META_RESPONSES_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${options.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: SAM_MODEL,
        store: false,
        // The parser documents c as the model's confidence per record. It orders matches
        // only. It is never shown as a measure of meaning or risk.
        metadata: { include_confidence: "true" },
        input: [{ type: "message", role: "user", content: [
          { type: "input_text", text: options.concept },
          { type: "input_image", image_url: options.image.dataUrl },
        ] }],
      }),
      cache: "no-store",
      redirect: "error",
      signal,
    });
    const raw = await readBoundedJson(response, signal, MAX_SAM_RESPONSE_BYTES);
    const text = samOutputText(raw);
    const parsed = await parseSamOutput(text);
    const frame = samFrameSize(text) ?? undefined;
    const image = options.image.width && options.image.height ? { width: options.image.width, height: options.image.height } : frame;
    if (!image) return { status: "not_found", objects: [] };
    const objects = objectsFromSamText(text, parsed.records, image);
    return { status: objects.length ? "found" : "not_found", objects, frame: image };
  } catch (error) {
    // A cancelled review stays cancelled. Every other failure leaves the assessment intact.
    if (options.signal.aborted) throw error;
    return { status: "failed", objects: [], failure: error instanceof ProviderHttpError ? "http" : signal.aborted ? "timeout" : "output" };
  }
}

export interface SegmentImageOptions extends Omit<SegmentOptions, "concept"> {
  findings: ReadonlyArray<{ visualConcept: string | null }>;
}

export async function segmentImage(options: SegmentImageOptions): Promise<{ segmentation: Segmentation; dropped: number; failures: SegmentationFailure[] }> {
  const { concepts, dropped } = conceptsFromFindings(options.findings);
  if (!concepts.length) return { segmentation: notRequestedSegmentation("no_visual_concepts"), dropped, failures: [] };
  const outcomes = await Promise.all(concepts.map((item) => segmentConcept({ ...options, concept: item.concept })));
  const regions: Region[] = [];
  const conceptResults = concepts.map((item, index) => {
    const outcome = outcomes[index]!;
    const regionIds: string[] = [];
    for (const object of outcome.objects) {
      const id = `G${regions.length + 1}`;
      regionIds.push(id);
      regions.push({ id, concept: item.concept, findingIndexes: item.findingIndexes, matchesForConcept: outcome.objects.length, ...object });
    }
    return { concept: item.concept, findingIndexes: item.findingIndexes, status: outcome.status, regionIds };
  });
  const statuses = outcomes.map((outcome) => outcome.status);
  const lost = statuses.filter((status) => status === "failed" || status === "skipped").length;
  const image = options.image.width && options.image.height
    ? { width: options.image.width, height: options.image.height }
    : outcomes.find((outcome) => outcome.frame)?.frame ?? null;
  const segmentation = segmentationSchema.parse({
    state: lost === 0 ? "completed" : lost === outcomes.length ? "failed" : "partial",
    reason: null, model: SAM_MODEL, image, concepts: conceptResults, regions,
  });
  return { segmentation, dropped, failures: outcomes.flatMap((outcome) => outcome.failure ? [outcome.failure] : []) };
}
