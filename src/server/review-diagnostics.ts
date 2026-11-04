import "server-only";
import { randomUUID } from "node:crypto";
import { diagnosticEventSchema, type DiagnosticCategory, type DiagnosticPayload } from "@/lib/review-diagnostics";
import type { ReviewResponse } from "@/lib/review-contract";

export function createReviewDiagnostics(write: (line: string) => void = (line) => console.info(line)) {
  const reviewId = randomUUID(), started = performance.now();
  let sequence = 0, finished = false;
  let failure: DiagnosticCategory | undefined;
  function emit(payload: DiagnosticPayload) {
    if (finished) return;
    try {
      const parsed = diagnosticEventSchema.safeParse({
        ...payload, schema: "narak.review.v1", reviewId, sequence: ++sequence,
        timestamp: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started),
      });
      if (parsed.success) write(JSON.stringify(parsed.data));
    } catch { /* Diagnostics must never change a review or echo rejected data. */ }
  }
  emit({ event: "review_started" });
  return {
    emit,
    fail(category: DiagnosticCategory) { failure = category; },
    // A retried stage that then succeeds no longer carries the first attempt's failure.
    clearFailure() { failure = undefined; },
    get failure() { return failure; },
    finish(response: ReviewResponse) {
      if (finished) return;
      emit({ event: "review_finished", durationMs: Math.round(performance.now() - started), state: response.state,
        ...(response.state === "completed" ? { outcome: response.result.outcome } : { category: failure ?? "unexpected_internal" }) });
      finished = true;
    },
  };
}
export type ReviewDiagnostics = ReturnType<typeof createReviewDiagnostics>;

// The input is never logged. Only bounded structural counts leave this function.
export function providerMetadata(raw: unknown) {
  const record = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
  const status = record.status;
  const providerStatus = typeof status === "string" && ["completed", "incomplete", "failed", "cancelled", "in_progress", "queued"].includes(status) ? status as "completed" | "incomplete" | "failed" | "cancelled" | "in_progress" | "queued" : "unknown";
  if (!Array.isArray(record.output) || record.output.length > 200) return { providerStatus };
  const searches = { completed: 0, searching: 0, in_progress: 0, failed: 0, unknown: 0 };
  const messages = { final: 0, commentary: 0, unknownPhase: 0 };
  let commentaryCitations = 0, commentaryCountable = true;
  let citationAnnotations = 0, citationsCountable = true;
  for (const item of record.output) {
    if (typeof item !== "object" || item === null) continue;
    if (item.type === "web_search_call") {
      switch (item.status) {
        case "completed": searches.completed++; break;
        case "searching": searches.searching++; break;
        case "in_progress": searches.in_progress++; break;
        case "failed": searches.failed++; break;
        default: searches.unknown++;
      }
    }
    if (item.type !== "message") continue;
    const commentary = item.phase === "commentary";
    if (commentary) messages.commentary++;
    else if (item.phase === "final_answer" || item.phase == null) messages.final++;
    else { messages.unknownPhase++; continue; }
    if (!Array.isArray(item.content) || item.content.length > 100) {
      if (commentary) commentaryCountable = false; else citationsCountable = false;
      continue;
    }
    for (const block of item.content) {
      if (!block || block.type !== "output_text") continue;
      if (block.annotations === undefined) continue;
      if (!Array.isArray(block.annotations) || block.annotations.length > 100) {
        if (commentary) commentaryCountable = false; else citationsCountable = false;
        continue;
      }
      const annotations = block.annotations.filter((entry: unknown) => typeof entry === "object" && entry !== null && (entry as { type?: unknown }).type === "url_citation").length;
      if (commentary) commentaryCitations += annotations; else citationAnnotations += annotations;
    }
  }
  return { providerStatus, searches, messages: { ...messages, ...(commentaryCountable ? { commentaryCitations } : {}) }, ...(citationsCountable ? { citationAnnotations } : {}) };
}
