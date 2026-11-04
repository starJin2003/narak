import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reviewWithMeta as reviewImplementation, type MetaOptions } from "@/server/meta";
import { parseMetaResponse } from "@/server/meta-response";
import { resultSchema, REVIEW_TIMEOUT_MS, type ReviewInput } from "@/lib/review-contract";
import { assessment, assessmentResponse, input, koreanCopy, researchResponse, researchText } from "./fixtures";

function fetchSequence(...responses: unknown[]) {
  const fetcher = vi.fn<typeof fetch>();
  for (const response of responses) fetcher.mockResolvedValueOnce(Response.json(response));
  return fetcher;
}

function reviewWithMeta(value: ReviewInput, options: MetaOptions = {}) {
  return reviewImplementation(value, { registryRetriever: async () => ({ state: "available", checkedCases: 0, matchedCaseIds: [], evidence: [] }), ...options });
}

beforeEach(() => vi.spyOn(console, "info").mockImplementation(() => undefined));
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("production model settings", () => {
  const bodies = (fetcher: ReturnType<typeof fetchSequence>) => fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));

  it("runs research with effort unset and the assessment at low effort, both on Muse Spark", async () => {
    const fetcher = fetchSequence(researchResponse(), assessmentResponse());
    await reviewWithMeta(input, { apiKey: "k", fetcher });
    const [research, assessed] = bodies(fetcher);
    expect([research.model, assessed.model]).toEqual(["muse-spark-1.3", "muse-spark-1.3"]);
    expect("reasoning" in research).toBe(false);
    expect(assessed.reasoning).toEqual({ effort: "low" });
    expect(research.tools).toEqual([{ type: "web_search", search_context_size: "medium" }]);
    expect(assessed.text.format).toMatchObject({ type: "json_schema", strict: true });
    expect([research.max_output_tokens, assessed.max_output_tokens]).toEqual([8_000, 8_000]);
    expect(JSON.stringify(bodies(fetcher))).not.toContain("muse-wonder");
  });
});

describe("Meta review adapter", () => {
  it("uses the documented endpoint and two stateless calls, preserving citation metadata", async () => {
    const fetcher = fetchSequence(researchResponse(), assessmentResponse());
    const result = await reviewWithMeta(input, { apiKey: "test-key", fetcher });
    expect(result.state).toBe("completed");
    if (result.state !== "completed") throw new Error("Expected completed fixture review");
    expect(result.result.outcome).toBe("emerging_signal");
    expect(result.result.verifiedCaseIds).toEqual([]);
    expect(result.result.sources).toHaveLength(1);
    expect(result.result.sources[0]).toMatchObject({
      responseId: "resp_research_fixture", messageId: "message_research_fixture", blockIndex: 0,
      annotation: { start_index: 0, end_index: researchText.length, provider_extra: "preserve-this" },
      citedPassage: researchText, evidenceState: "unverified",
    });
    expect(JSON.stringify(result)).not.toContain("uncited-result");
    expect(JSON.stringify(result)).not.toContain("test-key");
    expect(fetcher).toHaveBeenCalledTimes(2);
    const calls = fetcher.mock.calls.map(([url, options]) => {
      expect(url).toBe("https://api.meta.ai/v1/responses");
      expect(options?.cache).toBe("no-store");
      expect(options?.redirect).toBe("error");
      expect(options?.headers).toMatchObject({ Authorization: "Bearer test-key" });
      return JSON.parse(String(options?.body));
    });
    expect(calls[0]).toMatchObject({ model: "muse-spark-1.3", store: false, tools: [{ type: "web_search", search_context_size: "medium" }], max_tool_calls: 8, include: ["web_search_call.results"] });
    expect(calls[1]).toMatchObject({ store: false, text: { format: { type: "json_schema", strict: true } } });
    expect(calls[1]).not.toHaveProperty("tools");
    expect(calls[1]).not.toHaveProperty("max_tool_calls");
    expect(calls[1]).not.toHaveProperty("previous_response_id");
    expect(calls[1].input[0].content[0].text).toContain("S1");
    expect(calls[1].input[0].content[0].text).not.toContain("uncited-result");
  });

  it("qualifies negative findings by the actual cited scope", async () => {
    const result = await reviewWithMeta(input, { apiKey: "test", fetcher: fetchSequence(researchResponse(), assessmentResponse(assessment(false))) });
    expect(result.state).toBe("completed");
    if (result.state !== "completed") return;
    expect(result.result.outcome).toBe("no_supported_concern_found");
    expect(result.result.summary).toContain("within the cited material");
    expect(result.result.scope).toMatchObject({ citedSources: 1, completedSearches: 1, publicationDate: input.publicationDate });
    expect(result.result.limitations.length).toBeGreaterThanOrEqual(3);
  });

  // Only an unfinished search, an incomplete envelope or missing citations is retried, once.
  it.each([
    ["skipped search", { search: false }, "retrieval_incomplete", 1],
    ["no annotated evidence", { citations: false }, "insufficient_sources", 2],
    ["truncated output", { status: "incomplete" }, "assessment_incomplete", 2],
  ] as const)("reports %s as incomplete without an outcome", async (_, options, code, researchCalls) => {
    const fetcher = fetchSequence(researchResponse(options), researchResponse(options));
    expect(await reviewWithMeta(input, { apiKey: "test", fetcher })).toMatchObject({ state: "incomplete", result: null, issue: { code } });
    expect(fetcher).toHaveBeenCalledTimes(researchCalls);
  });

  it("does not trust URLs in generated prose without annotations", async () => {
    const raw = researchResponse({ citations: false });
    const message = raw.output.find((item) => item.type === "message")!;
    message.content![0]!.text = "A claim at https://example.com/invented must not become a source.";
    const fetcher = fetchSequence(raw, raw);
    expect(await reviewWithMeta(input, { apiKey: "test", fetcher })).toMatchObject({ state: "incomplete", result: null, issue: { code: "insufficient_sources" } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not accept a failed search even with valid annotations", async () => {
    const raw = researchResponse();
    raw.output.find((item) => item.type === "web_search_call")!.status = "failed";
    const fetcher = fetchSequence(raw, raw);
    expect(await reviewWithMeta(input, { apiKey: "test", fetcher })).toMatchObject({ state: "incomplete", issue: { code: "retrieval_incomplete" } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["in_progress", "searching", "failed"])("retries once, then blocks a completed envelope with a %s search item without assessment", async (status) => {
    const raw = researchResponse();
    // Even a duplicate ID later marked completed cannot erase an unfinished item.
    const completed = raw.output.find((item) => item.type === "web_search_call")!;
    raw.output.unshift({ type: "web_search_call", id: completed.id, status, action: { type: "search", query: "synthetic test query" }, results: [] });
    const fetcher = fetchSequence(raw, raw, assessmentResponse());
    const registryRetriever = vi.fn();
    const response = await reviewWithMeta(input, { apiKey: "test", fetcher, registryRetriever });
    expect(response).toMatchObject({ state: "incomplete", result: null, issue: { code: "retrieval_incomplete" } });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(registryRetriever).not.toHaveBeenCalled();
  });

  // Every non-completed envelope status is the provider_research_envelope_incomplete category.
  it.each(["incomplete", "failed", "cancelled", "in_progress", "queued"])("retries once, then blocks provider envelope status %s", async (status) => {
    const fetcher = fetchSequence(researchResponse({ status }), researchResponse({ status }));
    expect(await reviewWithMeta(input, { apiKey: "test", fetcher })).toMatchObject({ state: "incomplete", result: null, issue: { code: "assessment_incomplete" } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["unknown source", "embedded URL", "invented image", "verified outcome", "invalid schema"])("rejects %s in structured assessment", async (scenario) => {
    const value = assessment();
    let raw: unknown = value;
    if (scenario === "unknown source") value.findings[0]!.sourceIds = ["S999"];
    if (scenario === "embedded URL") value.findings[0]!.reportedClaim = "See https://example.com/invented";
    if (scenario === "invented image") value.observations[0]!.kind = "image";
    if (scenario === "verified outcome") raw = { ...value, outcome: "evidence_backed_concern" };
    if (scenario === "invalid schema") raw = { findings: "invalid" };
    // "verified outcome" is an extra key, rejected by the schema. Each case is retried once and still fails.
    const fetcher = fetchSequence(researchResponse(), assessmentResponse(raw), assessmentResponse(raw));
    expect(await reviewWithMeta(input, { apiKey: "test", fetcher })).toMatchObject({ state: "failed", result: null, issue: { code: "invalid_response" } });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("fails closed when the model says the evidence is insufficient", async () => {
    const value = { ...assessment(false), assessmentStatus: "insufficient" };
    expect(await reviewWithMeta(input, { apiKey: "test", fetcher: fetchSequence(researchResponse(), assessmentResponse(value)) })).toMatchObject({ state: "incomplete", result: null, issue: { code: "assessment_incomplete" } });
  });

  it("preserves Korean copy, new dates, and inline images in both requests", async () => {
    const fetcher = fetchSequence(researchResponse(), assessmentResponse());
    const latest: ReviewInput = { ...input, copy: koreanCopy, publicationDate: "2026-12-12", image: { mediaType: "image/png", dataUrl: "data:image/png;base64,dGVzdA==" } };
    await reviewWithMeta(latest, { apiKey: "test", fetcher });
    for (const [, options] of fetcher.mock.calls) {
      const body = JSON.parse(String(options?.body));
      expect(JSON.parse(body.input[0].content[0].text)).toMatchObject({ advertisementCopy: koreanCopy, proposedPublicationDate: "2026-12-12" });
      expect(body.input[0].content[1]).toEqual({ type: "input_image", image_url: latest.image!.dataUrl });
    }
  });

  it("reports missing and placeholder credentials without making any API call", async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const key of ["", "replace_with_your_meta_model_api_key"]) {
      vi.stubEnv("MODEL_API_KEY", key);
      expect(await reviewWithMeta(input, { fetcher })).toMatchObject({ state: "unavailable", result: null, issue: { code: "missing_credentials" } });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [401, "authentication"], [403, "authentication"], [429, "rate_limit"],
    [400, "unsupported_request"], [404, "unsupported_request"], [422, "unsupported_request"],
    [500, "provider_unavailable"], [504, "timeout"],
  ])("handles HTTP %s without leaking provider error details", async (status, code) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("secret provider body and key", { status: Number(status) }));
    const result = await reviewWithMeta(input, { apiKey: "sensitive-key", fetcher });
    expect(result).toMatchObject({ result: null, issue: { code } });
    expect(JSON.stringify(result)).not.toMatch(/secret provider|sensitive-key/);
  });

  it("handles provider network failures", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("sensitive network details"));
    const result = await reviewWithMeta(input, { apiKey: "test", fetcher });
    expect(result).toMatchObject({ state: "unavailable", issue: { code: "provider_unavailable" } });
    expect(JSON.stringify(result)).not.toContain("sensitive network");
  });

  it("aborts an overdue request with an explicit incomplete state", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_, options) => new Promise((_, reject) => {
      options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
    }));
    expect(await reviewWithMeta(input, { apiKey: "test", fetcher, timeoutMs: 10 })).toMatchObject({ state: "incomplete", result: null, issue: { code: "timeout" } });
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });

  it("does not call the provider for an already cancelled request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(await reviewWithMeta(input, { apiKey: "test", fetcher, signal: AbortSignal.abort() })).toMatchObject({ state: "incomplete", issue: { code: "cancelled" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("allows research beyond the old deadline but shares one deadline across both stages", async () => {
    vi.useFakeTimers();
    let finishResearch!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise((resolve) => { finishResearch = resolve; }))
      .mockImplementationOnce((_, options) => new Promise((_, reject) => {
        options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
      }));
    const pending = reviewWithMeta(input, { apiKey: "test", fetcher });
    await vi.advanceTimersByTimeAsync(100_000);
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(false);
    finishResearch(Response.json(researchResponse()));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(REVIEW_TIMEOUT_MS - 100_000);
    expect(await pending).toMatchObject({ state: "incomplete", result: null, issue: { code: "timeout" } });
    expect(fetcher.mock.calls[1]![1]!.signal!.aborted).toBe(true);
  });

  it("cancels a pending provider response body without starting another stage", async () => {
    const controller = new AbortController();
    let reading!: () => void;
    const started = new Promise<void>((resolve) => { reading = resolve; });
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull() { reading(); }, cancel });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    const pending = reviewWithMeta(input, { apiKey: "test", fetcher, signal: controller.signal });
    await started; controller.abort();
    expect(await pending).toMatchObject({ state: "incomplete", result: null, issue: { code: "cancelled" } });
    expect(cancel).toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["not JSON", JSON.stringify({ bad: true })])("rejects malformed provider responses", async (body) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    expect(await reviewWithMeta(input, { apiKey: "test", fetcher })).toMatchObject({ state: "failed", issue: { code: "invalid_response" } });
  });

  it("rejects invalid JSON in the assessment response", async () => {
    const value = assessmentResponse();
    value.output[0]!.content[0]!.text = "```json\n{}\n```";
    const fetcher = fetchSequence(researchResponse(), value, value);
    expect(await reviewWithMeta(input, { apiKey: "test", fetcher })).toMatchObject({ state: "failed", issue: { code: "invalid_response" } });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("the contract blocks verified concerns without a verified case record", async () => {
    const response = await reviewWithMeta(input, { apiKey: "test", fetcher: fetchSequence(researchResponse(), assessmentResponse()) });
    if (response.state !== "completed") throw new Error("Expected completed fixture review");
    expect(resultSchema.safeParse({ ...response.result, outcome: "evidence_backed_concern" }).success).toBe(false);
  });
});

describe("provider citation parsing", () => {
  it.each(["javascript:alert(1)", "https://user:password@example.com", "not-a-url"])("discards unsafe URL %s", (url) => {
    const raw = researchResponse();
    raw.output.find((item) => item.type === "message")!.content![0]!.annotations[0]!.url = url;
    expect(parseMetaResponse(raw)).toMatchObject({ sources: [], rejectedCitations: 1 });
  });

  it("keeps provider offsets and slices Unicode code points without shifting", () => {
    const raw = researchResponse();
    const block = raw.output.find((item) => item.type === "message")!.content![0]!;
    block.text = `\u{1F4CC} ${koreanCopy} context`;
    block.annotations[0]!.start_index = 2;
    block.annotations[0]!.end_index = 2 + Array.from(koreanCopy).length;
    expect(parseMetaResponse(raw).sources[0]!.citedPassage).toBe(koreanCopy);
  });

  it("rejects out-of-range citation spans", () => {
    const raw = researchResponse();
    raw.output.find((item) => item.type === "message")!.content![0]!.annotations[0]!.end_index = 9999;
    expect(parseMetaResponse(raw)).toMatchObject({ sources: [], rejectedCitations: 1 });
  });
});
