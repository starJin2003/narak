import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { diagnosticEventSchema } from "../src/lib/review-diagnostics.ts";

// Read-only and offline. Neither raw lines nor arbitrary JSON fields are echoed.
export function createLogSummary() {
  const groups = new Map();
  let malformedLines = 0, ignoredLines = 0, boundedLines = 0, lines = 0;
  return {
    addLine(line) {
      if (++lines > 100_000 || line.length > 16_384) { boundedLines++; return; }
      if (!line.trim()) return;
      let candidate;
      try {
        candidate = JSON.parse(line);
        if (candidate?.schema !== "narak.review.v1" && typeof candidate?.message === "string") candidate = JSON.parse(candidate.message);
      } catch { malformedLines++; return; }
      if (candidate?.schema !== "narak.review.v1") { ignoredLines++; return; }
      const parsed = diagnosticEventSchema.safeParse(candidate);
      if (!parsed.success) { malformedLines++; return; }
      const event = parsed.data;
      if (!groups.has(event.reviewId)) {
        if (groups.size >= 10_000) { boundedLines++; return; }
        groups.set(event.reviewId, { events: new Map(), duplicates: false });
      }
      const group = groups.get(event.reviewId);
      if (group.events.has(event.sequence)) { group.duplicates = true; return; }
      group.events.set(event.sequence, event);
    },
    result() {
      const outcomes = { completed: 0, incomplete: 0, unavailable: 0, failed: 0, unknown: 0 };
      const reviews = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([reviewId, group]) => {
        const events = [...group.events.values()].sort((a, b) => a.sequence - b.sequence);
        const notes = [];
        const start = events.find((event) => event.event === "review_started");
        const finishes = events.filter((event) => event.event === "review_finished");
        const finish = finishes.length === 1 ? finishes[0] : undefined;
        if (!start) notes.push("missing_start"); if (!finish) notes.push("missing_finish");
        if (group.duplicates || finishes.length > 1) notes.push("duplicate_or_conflicting_entries");
        if (events.some((event, index) => event.sequence !== index + 1)) notes.push("sequence_gap");
        if (finish && events.at(-1) !== finish) notes.push("events_after_finish");
        const stages = {};
        for (const stage of ["research", "assessment"]) {
          const began = events.some((event) => event.event === "provider_started" && event.stage === stage);
          const measured = events.filter((event) => event.event === "provider_finished" && event.stage === stage);
          if (began && measured.length !== 1) notes.push("missing_stage_data");
          if (!began && measured.length) notes.push("missing_stage_data");
          if (measured.length > 1) notes.push("duplicate_or_conflicting_entries");
          const end = measured.length === 1 ? measured[0] : undefined;
          stages[stage] = end ? {
            state: "measured", durationMs: end.durationMs, httpStatus: end.httpStatus ?? null,
            providerStatus: end.providerStatus ?? null, searches: end.searches ?? null,
            messages: end.messages ?? null,
            citationAnnotations: end.citationAnnotations ?? null, acceptedSources: end.acceptedSources ?? null,
            rejectedCitations: end.rejectedCitations ?? null,
          } : { state: !began && notes.length === 0 && finish ? "not_reached" : "not_observed_missing_or_expired", durationMs: null };
        }
        if (finish?.state === "completed" && (!events.some((event) => event.event === "assessment_checked" && event.result === "valid") || stages.research.state !== "measured" || stages.assessment.state !== "measured")) notes.push("missing_stage_data");
        if (notes.length) for (const stage of Object.values(stages)) if (stage.state === "not_reached") stage.state = "not_observed_missing_or_expired";
        const state = finish?.state ?? "unknown"; outcomes[state]++;
        return {
          reviewId, logData: notes.length ? "missing_or_expired" : "complete", notes: [...new Set(notes)],
          startedAt: start?.timestamp ?? null, state, outcome: finish?.outcome ?? null,
          totalDurationMs: finish?.durationMs ?? null, stages,
          researchCheck: events.find((event) => event.event === "research_checked")?.result ?? null,
          registry: events.filter((event) => event.event === "registry_checked").map((event) => ({ state: event.state, selectedCases: event.selectedCases ?? null, code: event.code ?? null })),
          assessmentCheck: events.find((event) => event.event === "assessment_checked")?.result ?? null,
          categories: [...new Set(events.flatMap((event) => event.category ? [event.category] : []))],
        };
      });
      return { inputStatus: reviews.length ? "review_data_observed" : "no_review_data_missing_or_expired", malformedLines, ignoredLines, boundedLines, outcomes, reviews };
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length > 3) { console.error("Use one local JSONL file or standard input."); process.exitCode = 1; }
  else {
    try {
      const summary = createLogSummary();
      const input = !process.argv[2] || process.argv[2] === "-" ? process.stdin : createReadStream(process.argv[2]);
      for await (const line of createInterface({ input, crlfDelay: Infinity })) summary.addLine(line);
      console.log(JSON.stringify(summary.result(), null, 2));
    } catch { console.error("Could not read local diagnostic input."); process.exitCode = 1; }
  }
}
