import { z } from "zod";
import { reviewResponseSchema, type ReviewResponse } from "./review-contract";
import { RESPONSE_BUDGET } from "./transport";

// Stage events a live review streams while it runs. Each one records something that already
// happened on the server. Counts only: no source text, no model output, no estimate of time
// or progress, so nothing here can be read as a result.
export const reviewProgressSchema = z.discriminatedUnion("stage", [
  z.strictObject({ stage: z.literal("research_started") }),
  z.strictObject({ stage: z.literal("research_retried") }),
  z.strictObject({ stage: z.literal("research_accepted"), pages: z.number().int().min(0).max(500) }),
  z.strictObject({ stage: z.literal("cases_checked"), checked: z.number().int().min(0).max(50), selected: z.number().int().min(0).max(3) }),
  z.strictObject({ stage: z.literal("cases_unavailable") }),
  z.strictObject({ stage: z.literal("assessment_started") }),
  z.strictObject({ stage: z.literal("assessment_retried") }),
  z.strictObject({ stage: z.literal("assessment_checked") }),
  z.strictObject({ stage: z.literal("regions_started"), elements: z.number().int().min(1).max(3) }),
  z.strictObject({ stage: z.literal("regions_finished") }),
]);
export type ReviewProgress = z.infer<typeof reviewProgressSchema>;

// One review emits at most this many stage events. Anything beyond is dropped on the server
// and refused by the reader, so a faulty stream cannot grow without bound.
export const MAX_PROGRESS_EVENTS = 12;
export const MAX_PROGRESS_LINE = 256;
export const REVIEW_STREAM_TYPE = "application/x-ndjson";
// Safari holds a streamed reply until it has 1,024 bytes. The opening line is padded past
// that, so the first stage event shows when it happens there too.
export const STREAM_OPEN_PADDING = 1_100;

const progressLineSchema = z.strictObject({ type: z.literal("progress"), event: reviewProgressSchema });
const resultLineSchema = z.strictObject({ type: z.literal("result"), response: reviewResponseSchema });

export function openLine(): string {
  return `${JSON.stringify({ type: "open" })}${" ".repeat(STREAM_OPEN_PADDING)}\n`;
}
export function progressLine(event: ReviewProgress): string {
  return `${JSON.stringify({ type: "progress", event: reviewProgressSchema.parse(event) })}\n`;
}
export function resultLine(response: ReviewResponse): string {
  return `${JSON.stringify({ type: "result", response })}\n`;
}

export type StreamOutcome = { kind: "result"; response: ReviewResponse } | { kind: "broken" };

// Reads the review stream line by line. Stage events reach onProgress in the order they
// arrive. The stream counts as broken, and no result is returned, when it ends without a
// result, carries a line that does not match the contract, exceeds the size budgets, or
// continues after its result. A cancelled read rejects with the abort error.
export async function readReviewStream(body: ReadableStream<Uint8Array>, listen: { onOpen?: () => void; onProgress: (event: ReviewProgress) => void }, signal?: AbortSignal): Promise<StreamOutcome> {
  const { onOpen, onProgress } = listen;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", received = 0, events = 0, opened = false;
  let response: ReviewResponse | null = null;
  const stop = () => { reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", stop, { once: true });
  // Returns false when the line breaks the contract.
  const take = (raw: string): boolean => {
    const line = raw.trim();
    if (!line) return true;
    if (response) return false;
    let value: unknown;
    try { value = JSON.parse(line); } catch { return false; }
    if (!opened) {
      opened = true;
      const valid = typeof value === "object" && value !== null && (value as { type?: unknown }).type === "open" && Object.keys(value).length === 1;
      if (valid) onOpen?.();
      return valid;
    }
    const progress = progressLineSchema.safeParse(value);
    if (progress.success) {
      if (line.length > MAX_PROGRESS_LINE || ++events > MAX_PROGRESS_EVENTS) return false;
      onProgress(progress.data.event);
      return true;
    }
    const result = resultLineSchema.safeParse(value);
    if (!result.success) return false;
    response = result.data.response;
    return true;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      received += value.byteLength;
      if (received > RESPONSE_BUDGET + STREAM_OPEN_PADDING + MAX_PROGRESS_EVENTS * MAX_PROGRESS_LINE + 1_024) { stop(); return { kind: "broken" }; }
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        if (!take(buffer.slice(0, newline))) { stop(); return { kind: "broken" }; }
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (!take(buffer)) return { kind: "broken" };
    return response ? { kind: "result", response } : { kind: "broken" };
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}

// Plain words for each stage event. Shown and announced exactly as written here.
export function progressText(event: ReviewProgress): { title: string; detail: string } {
  const pages = (count: number) => `${count.toLocaleString("en-US")} ${count === 1 ? "page" : "pages"}`;
  switch (event.stage) {
    case "research_started": return { title: "Web research started", detail: "Muse Spark searches the web and cites the pages it uses." };
    case "research_retried": return { title: "Web research is running again", detail: "The first attempt could not be used, so it runs once more." };
    case "research_accepted": return { title: `${pages(event.pages)} cited and accepted`, detail: "Every citation was well formed, with a passage and a page address." };
    case "cases_checked": return {
      title: `${event.checked.toLocaleString("en-US")} documented ${event.checked === 1 ? "case" : "cases"} checked`,
      detail: event.selected ? `${event.selected} selected for the assessment.` : "None selected for the assessment.",
    };
    case "cases_unavailable": return { title: "Documented cases could not be read", detail: "This is a coverage gap in this review." };
    case "assessment_started": return { title: "Assessment running", detail: "A separate Muse Spark call weighs the cited passages and documented cases." };
    case "assessment_retried": return { title: "Assessment is running again", detail: "The first answer did not pass the checks, so it runs once more." };
    case "assessment_checked": return { title: "Assessment checked", detail: "The answer passed the server's evidence rules." };
    case "regions_started": return {
      title: `Locating ${event.elements === 1 ? "one named element" : `${event.elements} named elements`}`,
      detail: "SAM 3.1 outlines where each element appears on the poster.",
    };
    case "regions_finished": return { title: "Regions located", detail: "SAM 3.1 finished. The result is being prepared." };
  }
}

// The six steps of a review, in order. During a review each step is marked only from stream
// events that happened. A step is complete only when the event that completes it arrived.
export const REVIEW_STEPS = [
  { name: "Poster and date", by: "Your upload" },
  { name: "Cited web research", by: "Muse Spark" },
  { name: "Documented cases", by: "NARAK registry" },
  { name: "Assessment and evidence checks", by: "Muse Spark and server rules" },
  { name: "Regions", by: "SAM 3.1" },
  { name: "Optional variant test", by: "Muse Image" },
] as const;
export type StepState = { state: "idle" | "active" | "done" | "gap"; note?: string };

export function reviewSteps(running: boolean, opened: boolean, events: readonly ReviewProgress[]): StepState[] {
  const steps: StepState[] = REVIEW_STEPS.map(() => ({ state: "idle" }));
  if (!running) return steps;
  const has = (stage: ReviewProgress["stage"]) => events.some((event) => event.stage === stage);
  const find = <S extends ReviewProgress["stage"]>(stage: S) => events.find((event): event is Extract<ReviewProgress, { stage: S }> => event.stage === stage);
  steps[0] = opened ? { state: "done", note: "Received" } : { state: "active", note: "Sending" };
  const accepted = find("research_accepted");
  const retried = has("research_retried");
  if (accepted) steps[1] = { state: "done", note: `${accepted.pages.toLocaleString("en-US")} ${accepted.pages === 1 ? "page" : "pages"} cited${retried ? ", after one retry" : ""}` };
  else if (has("research_started")) steps[1] = { state: "active", note: retried ? "Running again after a retry" : undefined };
  const cases = find("cases_checked");
  if (cases) steps[2] = { state: "done", note: `${cases.checked.toLocaleString("en-US")} checked, ${cases.selected} selected` };
  else if (has("cases_unavailable")) steps[2] = { state: "gap", note: "Could not be read" };
  else if (accepted) steps[2] = { state: "active" };
  const again = has("assessment_retried");
  if (has("assessment_checked")) steps[3] = { state: "done", note: again ? "Passed after one retry" : "Passed" };
  else if (has("assessment_started")) steps[3] = { state: "active", note: again ? "Running again after a retry" : undefined };
  const regions = find("regions_started");
  if (has("regions_finished")) steps[4] = { state: "done" };
  else if (regions) steps[4] = { state: "active", note: `Locating ${regions.elements === 1 ? "one element" : `${regions.elements} elements`}` };
  return steps;
}
