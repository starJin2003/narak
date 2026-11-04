import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reviewWithMeta } from "@/server/meta";
import { createReviewDiagnostics } from "@/server/review-diagnostics";
import { diagnosticEventSchema } from "@/lib/review-diagnostics";
import { POST } from "@/app/api/review/route";
import { createLogSummary } from "../scripts/review-logs.mjs";
import { assessment, assessmentResponse, input, researchResponse } from "./fixtures";

const empty = { state: "available", checkedCases: 0, matchedCaseIds: [], evidence: [] };
function sequence(...responses) {
  const fetcher = vi.fn(); for (const value of responses) fetcher.mockResolvedValueOnce(Response.json(value)); return fetcher;
}
async function run(fetcher = sequence(researchResponse(), assessmentResponse()), options = {}, creative = input) {
  const lines = [], diagnostics = createReviewDiagnostics((line) => lines.push(line));
  const response = await reviewWithMeta(creative, { apiKey: "synthetic-private-key", registryRetriever: async () => empty, ...options, fetcher, diagnostics });
  diagnostics.finish(response);
  return { response, lines, events: lines.map((line) => JSON.parse(line)), fetcher };
}
const last = (result) => result.events.at(-1);
function summarize(lines) { const reader = createLogSummary(); for (const line of lines) reader.addLine(line); return reader.result(); }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("safe review diagnostics", () => {
  it("records one complete two-stage lifecycle with real measured durations and no response-contract changes", async () => {
    const value = await run();
    expect(value.response.state).toBe("completed"); expect(value.fetcher).toHaveBeenCalledTimes(2);
    expect(value.events.map((event) => event.event)).toEqual(["review_started", "provider_started", "provider_finished", "research_checked", "registry_checked", "provider_started", "provider_finished", "assessment_checked", "review_finished"]);
    expect(new Set(value.events.map((event) => event.reviewId)).size).toBe(1);
    expect(value.events.map((event) => event.sequence)).toEqual([1,2,3,4,5,6,7,8,9]);
    expect(value.events.every((event) => diagnosticEventSchema.safeParse(event).success)).toBe(true);
    expect(value.events[2]).toMatchObject({ stage: "research", httpStatus: 200, providerStatus: "completed", searches: { completed: 1, failed: 0, searching: 0, in_progress: 0, unknown: 0 }, citationAnnotations: 1, acceptedSources: 1 });
    expect(value.events[2].durationMs).toBeGreaterThanOrEqual(0);
    expect(value.events[6]).toMatchObject({ stage: "assessment", providerStatus: "completed", acceptedSources: 0 });
    expect(last(value)).toMatchObject({ state: "completed", outcome: "emerging_signal" });
    expect(JSON.stringify(value.response)).not.toMatch(/reviewId|narak\.review\.v1/);
    expect(summarize(value.lines)).toMatchObject({ outcomes: { completed: 1 }, reviews: [{ logData: "complete", assessmentCheck: "valid" }] });
  });
  it.each(["searching", "in_progress", "failed"])("distinguishes a completed envelope from a %s search", async (status) => {
    const raw = researchResponse(); raw.output.find((item) => item.type === "web_search_call").status = status;
    const value = await run(sequence(raw, raw));
    expect(value.response).toMatchObject({ state: "incomplete", issue: { code: "retrieval_incomplete" } });
    expect(value.events.find((event) => event.event === "provider_finished")).toMatchObject({ providerStatus: "completed", searches: { [status]: 1 } });
    expect(value.events.filter((event) => event.event === "research_retried")).toEqual([expect.objectContaining({ reason: "unfinished_search_items" })]);
    expect(last(value).category).toBe("unfinished_search_items"); expect(value.fetcher).toHaveBeenCalledTimes(2);
    const review = summarize(value.lines).reviews[0];
    expect(review.stages.assessment).toEqual({ state: "not_reached", durationMs: null });
    expect(review.stages.research).toMatchObject({ state: "measured", attempts: 2 });
    expect(review.researchRetries).toEqual([expect.objectContaining({ reason: "unfinished_search_items" })]);
    expect(review.notes).toEqual([]);
  });
  it("classifies provider envelope incompletion without inventing accepted-source measurements", async () => {
    const value = await run(sequence(researchResponse({ status: "incomplete" }), researchResponse({ status: "incomplete" })));
    expect(last(value).category).toBe("provider_research_envelope_incomplete");
    expect(value.events.filter((event) => event.event === "research_retried")).toEqual([expect.objectContaining({ reason: "provider_research_envelope_incomplete" })]);
    const provider = value.events.find((event) => event.event === "provider_finished");
    expect(provider.providerStatus).toBe("incomplete"); expect(provider).not.toHaveProperty("acceptedSources");
  });
  it("counts unknown search statuses without logging their contents or accepting them", async () => {
    const raw = researchResponse(); raw.output.find((item) => item.type === "web_search_call").status = "private-unknown-status";
    const value = await run(sequence(raw));
    expect(value.response.state).toBe("failed");
    expect(value.events.find((event) => event.event === "provider_finished").searches.unknown).toBe(1);
    expect(value.lines.join()).not.toContain("private-unknown-status");
  });
  // Missing citations are retried once. Malformed citations are never retried.
  it.each([false, true])("classifies missing or malformed citations (malformed=%s)", async (malformed) => {
    const raw = researchResponse({ citations: malformed });
    if (malformed) raw.output.find((item) => item.type === "message").content[0].annotations[0].url = "javascript:private-source-content";
    const value = await run(sequence(raw, raw));
    expect(last(value).category).toBe(malformed ? "invalid_citations" : "missing_citations");
    const provider = value.events.find((event) => event.event === "provider_finished");
    expect(provider.citationAnnotations).toBe(malformed ? 1 : 0); expect(provider.acceptedSources).toBe(0);
    expect(value.response.state).toBe("incomplete"); expect(value.fetcher).toHaveBeenCalledTimes(malformed ? 1 : 2);
    expect(value.events.filter((event) => event.event === "research_retried").map((event) => event.reason)).toEqual(malformed ? [] : ["missing_citations"]);
    expect(value.lines.join()).not.toContain("private-source-content");
  });
  it.each(["schema", "source", "insufficient"])("classifies assessment %s failures", async (kind) => {
    let data = assessment();
    if (kind === "schema") data = { secretArbitraryBody: "must-not-appear" };
    if (kind === "source") data.findings[0].sourceIds = ["S-SECRET-UNKNOWN"];
    if (kind === "insufficient") data.assessmentStatus = "insufficient";
    // Invalid output is retried once with the same reply. Insufficient is not retried.
    const value = await run(kind === "insufficient" ? sequence(researchResponse(), assessmentResponse(data)) : sequence(researchResponse(), assessmentResponse(data), assessmentResponse(data)));
    expect(last(value).category).toBe(kind === "schema" ? "assessment_schema_invalid" : kind === "source" ? "unknown_source_reference" : "assessment_insufficient");
    expect(value.events.filter((event) => event.event === "assessment_retried")).toHaveLength(kind === "insufficient" ? 0 : 1);
    if (kind === "source") expect(value.events.filter((event) => event.event === "unknown_source_ids")).toEqual(Array(2).fill(expect.objectContaining({ field: "sourceIds", S: 0, R: 0, other: 1 })));
    if (kind === "insufficient") expect(value.events.find((event) => event.event === "assessment_insufficient")).toMatchObject({ reason: "other" });
    expect(value.events.find((event) => event.event === "assessment_checked").result).toBe(kind === "insufficient" ? "insufficient" : "invalid");
    expect(value.lines.join()).not.toMatch(/must-not-appear|S-SECRET-UNKNOWN/);
  });
  it("records an unavailable registry without inventing a selected-case count", async () => {
    const value = await run(undefined, { registryRetriever: async () => ({ state: "unavailable", code: "database_unavailable" }) });
    expect(value.events.find((event) => event.event === "registry_checked")).toMatchObject({ state: "unavailable", category: "registry_unavailable" });
    expect(value.events.find((event) => event.event === "registry_checked")).not.toHaveProperty("selectedCases");
    expect(value.response.state).toBe("completed"); // Supported emerging finding, with the existing coverage gap.
  });
  it.each([[401,"provider_authentication"],[402,"provider_billing"],[429,"provider_quota"],[500,"provider_unavailable"],[504,"provider_timeout"],[422,"unsupported_provider_request"]])("classifies HTTP %s without logging the provider body", async (status, category) => {
    const value = await run(vi.fn().mockResolvedValue(new Response("PRIVATE-PROVIDER-BODY", { status })));
    expect(last(value).category).toBe(category); expect(value.lines.join()).not.toContain("PRIVATE-PROVIDER-BODY");
    expect(value.fetcher).toHaveBeenCalledTimes(1);
  });
  it("separates transport failure from an unexpected registry failure and never logs exceptions", async () => {
    const network = await run(vi.fn().mockRejectedValue(new Error("PRIVATE-URL-password-stack")));
    expect(last(network).category).toBe("provider_transport");
    const internal = await run(undefined, { registryRetriever: async () => { throw new Error("PRIVATE-DATABASE-ERROR"); } });
    expect(last(internal).category).toBe("unexpected_internal");
    expect([...network.lines,...internal.lines].join()).not.toMatch(/PRIVATE-|stack|password/);
  });
  it("does not infer a local deadline from a transport exception name", async () => {
    const value = await run(vi.fn().mockRejectedValue(new DOMException("PRIVATE-TIMEOUT-MESSAGE", "TimeoutError")));
    expect(value.response).toMatchObject({ state: "incomplete", issue: { code: "timeout" } });
    expect(last(value).category).toBe("provider_transport");
    expect(value.lines.join()).not.toContain("PRIVATE-TIMEOUT-MESSAGE");
  });
  it("classifies a broken provider response stream as transport failure", async () => {
    const body = new ReadableStream({ start(controller) { controller.error(new Error("PRIVATE-BODY-ERROR")); } });
    const value = await run(vi.fn().mockResolvedValue(new Response(body)));
    expect(last(value).category).toBe("provider_transport");
    expect(value.lines.join()).not.toContain("PRIVATE-BODY-ERROR");
  });
  it.each(["cancel", "deadline"])("records %s while a provider request is pending", async (kind) => {
    const controller = new AbortController();
    let started; const ready = new Promise((resolve) => { started = resolve; });
    const fetcher = vi.fn().mockImplementation((_, options) => new Promise((_, reject) => {
      started(); options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    }));
    const pending = run(fetcher, { signal: controller.signal, timeoutMs: kind === "deadline" ? 10 : 1000 });
    await ready; if (kind === "cancel") controller.abort();
    const value = await pending;
    expect(last(value).category).toBe(kind === "cancel" ? "client_cancelled" : "review_deadline_exceeded");
    expect(value.response.state).toBe("incomplete"); expect(value.fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not log keys, credentials, copy, image contents, headers, source text or exception details", async () => {
    const privateValues = ["SECRET-KEY", "SECRET-COPY", "SECRET-IMAGE", "SECRET-ARTICLE", "SECRET-ANNOTATION", "SECRET-DATABASE"];
    vi.stubEnv("DATABASE_MIGRATION_URL", "SECRET-DATABASE");
    const raw = researchResponse(); const block = raw.output.find((item) => item.type === "message").content[0];
    block.text = "SECRET-ARTICLE"; block.annotations[0].end_index = block.text.length; block.annotations[0].provider_extra = "SECRET-ANNOTATION";
    const value = await run(sequence(raw, assessmentResponse()), { apiKey: "SECRET-KEY" }, { ...input, copy: "SECRET-COPY", image: { mediaType: "image/png", dataUrl: "data:image/png;base64,SECRET-IMAGE" } });
    for (const secret of privateValues) expect(value.lines.join()).not.toContain(secret);
    const lines = [], diagnostics = createReviewDiagnostics((line) => lines.push(line));
    diagnostics.emit({ event: "research_checked", result: "rejected", category: "SECRET-COPY" });
    diagnostics.emit({ event: "review_started", copy: "SECRET-COPY", authorization: "SECRET-KEY" });
    expect(lines).toHaveLength(1);
    expect(diagnosticEventSchema.safeParse({ ...JSON.parse(lines[0]), copy: "SECRET-COPY" }).success).toBe(false);
  });
  it("correlates concurrent reviews independently and survives a broken log sink", async () => {
    const [a,b] = await Promise.all([run(),run()]);
    expect(a.events[0].reviewId).not.toBe(b.events[0].reviewId);
    const summary = summarize(a.lines.flatMap((line,index) => [line,b.lines[index]]));
    expect(summary.outcomes.completed).toBe(2); expect(summary.reviews.every((review) => review.logData === "complete")).toBe(true);
    const diagnostics = createReviewDiagnostics(() => { throw new Error("PRIVATE-SINK-FAILURE"); });
    const response = await reviewWithMeta(input, { apiKey: "test", diagnostics, fetcher: sequence(researchResponse(),assessmentResponse()), registryRetriever: async () => empty });
    expect(response.state).toBe("completed"); expect(() => diagnostics.finish(response)).not.toThrow();
  });
  it("logs rejected route requests under one ID without recording headers or body data", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const response = await POST(new Request("http://localhost/api/review", { method: "POST", headers: { origin: "https://private-origin.example", authorization: "SECRET-AUTH", cookie: "SECRET-COOKIE", "x-forwarded-for": "192.0.2.44" }, body: "SECRET-CREATIVE" }));
    expect(response.status).toBe(403);
    const lines = info.mock.calls.map(([line]) => line);
    expect(lines).toHaveLength(2); expect(summarize(lines).reviews[0]).toMatchObject({ state: "failed", categories: ["invalid_input"] });
    expect(lines.join()).not.toMatch(/private-origin|SECRET|192\.0\.2\.44|cookie|authorization/);
  });
});

describe("offline log summaries", () => {
  it("marks absent, truncated, malformed and unsupported data without printing it", async () => {
    expect(summarize([])).toMatchObject({ inputStatus: "no_review_data_missing_or_expired", reviews: [] });
    const value = await run();
    const result = summarize([value.lines[2], "not-json SECRET-KEY", JSON.stringify({ message: "SECRET-ARTICLE" }), JSON.stringify({ unrelated: "SECRET-COPY" }), JSON.stringify({ ...value.events[0], secret: "SECRET-DATABASE" })]);
    expect(result.malformedLines).toBe(3); expect(result.ignoredLines).toBe(1);
    expect(result.reviews[0]).toMatchObject({ logData: "missing_or_expired", state: "unknown", totalDurationMs: null });
    expect(result.reviews[0].notes).toContain("missing_finish");
    expect(result.reviews[0].stages.assessment.durationMs).toBeNull();
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
  it("accepts message-only Vercel JSON wrappers, handles reordered lines and flags duplicate/gapped data", async () => {
    const value = await run();
    expect(summarize([...value.lines].reverse().map((message) => JSON.stringify({ message, ip: "SECRET-IP", headers: "SECRET-HEADERS" }))).reviews[0].logData).toBe("complete");
    const result = summarize([...value.lines.slice(1),value.lines[1]]);
    expect(result.reviews[0].notes).toContain("duplicate_or_conflicting_entries");
    expect(result.reviews[0].notes).toContain("sequence_gap");
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
  it("bounds oversized lines without echoing them", () => {
    expect(summarize(["SECRET".repeat(4000)])).toMatchObject({ boundedLines: 1, reviews: [] });
  });
  it("runs the local read-only CLI on standard input and reports fixed safe read errors", async () => {
    const value = await run();
    const args = ["--experimental-strip-types", "scripts/review-logs.mjs"];
    const output = execFileSync(process.execPath, args, { input: value.lines.join("\n"), encoding: "utf8" });
    expect(JSON.parse(output).outcomes.completed).toBe(1);
    const missing = spawnSync(process.execPath, [...args,"/nonexistent/SECRET-FILENAME"], { encoding: "utf8" });
    expect(missing.status).toBe(1); expect(missing.stderr).not.toContain("SECRET-FILENAME");
  });
});
