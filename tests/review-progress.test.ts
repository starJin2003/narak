import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PROGRESS_EVENTS, REVIEW_STEPS, openLine, progressLine, progressText, readReviewStream, resultLine, reviewProgressSchema, reviewSteps, type ReviewProgress,
} from "@/lib/review-progress";
import { reviewResponseSchema, type ReviewResponse } from "@/lib/review-contract";
import { reviewWithMeta, type MetaOptions } from "@/server/meta";
import { createReviewDiagnostics } from "@/server/review-diagnostics";
import { assessment, assessmentResponse, input, researchResponse, researchText } from "./fixtures";

beforeEach(() => vi.spyOn(console, "info").mockImplementation(() => undefined));
afterEach(() => vi.restoreAllMocks());

const encoder = new TextEncoder();
// A body that delivers the given chunks in order, split wherever the test chooses.
function body(chunks: string[]) {
  return new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); } });
}
const failed: ReviewResponse = { state: "incomplete", result: null, issue: { code: "timeout", message: "m", retryable: true } };

describe("review stream reader", () => {
  it("passes stage events in arrival order, across chunk boundaries, and returns the one result", async () => {
    const text = openLine() + progressLine({ stage: "research_started" }) + progressLine({ stage: "research_accepted", pages: 4 }) + resultLine(failed);
    const chunks = [text.slice(0, 7), text.slice(7, 1130), text.slice(1130, 1150), text.slice(1150)];
    const seen: ReviewProgress[] = [];
    let opened = 0;
    const outcome = await readReviewStream(body(chunks), { onOpen: () => { opened += 1; }, onProgress: (event) => { seen.push(event); } });
    expect(opened).toBe(1);
    expect(seen).toEqual([{ stage: "research_started" }, { stage: "research_accepted", pages: 4 }]);
    expect(outcome).toEqual({ kind: "result", response: failed });
  });

  it.each([
    ["ends without a result", [openLine(), progressLine({ stage: "research_started" })]],
    ["misses the opening line", [progressLine({ stage: "research_started" }), resultLine(failed)]],
    ["carries a line that is not JSON", [openLine(), "{not json\n", resultLine(failed)]],
    ["carries a stage event with extra fields", [openLine(), `${JSON.stringify({ type: "progress", event: { stage: "research_started", note: "source text" } })}\n`, resultLine(failed)]],
    ["carries a result that breaks the review contract", [openLine(), `${JSON.stringify({ type: "result", response: { state: "completed", result: {} } })}\n`]],
    ["continues after its result", [openLine(), resultLine(failed), progressLine({ stage: "assessment_started" })]],
    ["sends more stage events than one review can", [openLine(), ...Array.from({ length: MAX_PROGRESS_EVENTS + 1 }, () => progressLine({ stage: "assessment_started" })), resultLine(failed)]],
    ["is empty", []],
  ])("counts a stream as broken when it %s", async (_, chunks) => {
    expect(await readReviewStream(body(chunks as string[]), { onProgress: () => undefined })).toEqual({ kind: "broken" });
  });

  it("refuses a stream larger than the response budget", async () => {
    const huge = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(1_000_000).fill(32)); } });
    expect(await readReviewStream(huge, { onProgress: () => undefined })).toEqual({ kind: "broken" });
  });

  it("stops reading and rejects when the review is cancelled", async () => {
    let cancelled = false;
    let push: ((text: string) => void) | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { push = (text) => controller.enqueue(encoder.encode(text)); },
      cancel() { cancelled = true; },
    });
    const abort = new AbortController();
    const seen: ReviewProgress[] = [];
    const reading = readReviewStream(stream, { onProgress: (event) => { seen.push(event); } }, abort.signal);
    push!(openLine() + progressLine({ stage: "research_started" }));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    abort.abort();
    await expect(reading).rejects.toThrow();
    expect(cancelled).toBe(true);
  });

  it("words every stage without estimates, percentages or content", () => {
    const events: ReviewProgress[] = [
      { stage: "research_started" }, { stage: "research_retried" }, { stage: "research_accepted", pages: 1 }, { stage: "cases_checked", checked: 1, selected: 0 },
      { stage: "cases_unavailable" }, { stage: "assessment_started" }, { stage: "assessment_retried" }, { stage: "assessment_checked" },
      { stage: "regions_started", elements: 1 }, { stage: "regions_finished" },
    ];
    const words = events.map((event) => { const text = progressText(event); return `${text.title} ${text.detail}`; }).join(" ");
    expect(words).not.toMatch(/%|remaining|left to|estimate|minutes|seconds/i);
    expect(progressText({ stage: "research_accepted", pages: 1 }).title).toBe("1 page cited and accepted");
    expect(progressText({ stage: "cases_checked", checked: 3, selected: 1 })).toEqual({ title: "3 documented cases checked", detail: "1 selected for the assessment." });
    expect(reviewProgressSchema.safeParse({ stage: "regions_started", elements: 4 }).success).toBe(false);
  });
});

describe("how a review works", () => {
  const all: ReviewProgress[] = [{ stage: "research_started" }, { stage: "research_retried" }, { stage: "research_accepted", pages: 6 },
    { stage: "cases_checked", checked: 3, selected: 1 }, { stage: "assessment_started" }, { stage: "assessment_checked" }, { stage: "regions_started", elements: 2 }, { stage: "regions_finished" }];
  const states = (opened: boolean, events: ReviewProgress[]) => reviewSteps(true, opened, events).map((step) => step.state);

  it("lists the six steps in order", () => {
    expect(REVIEW_STEPS.map((step) => step.name)).toEqual(["Poster and date", "Cited web research", "Documented cases", "Assessment and evidence checks", "Regions", "Optional variant test"]);
    expect(reviewSteps(false, false, all).every((step) => step.state === "idle")).toBe(true);
  });

  it("marks a step complete only after the event that completes it", () => {
    expect(states(false, [])).toEqual(["active", "idle", "idle", "idle", "idle", "idle"]);
    expect(states(true, all.slice(0, 1))).toEqual(["done", "active", "idle", "idle", "idle", "idle"]);
    expect(states(true, all.slice(0, 3))).toEqual(["done", "done", "active", "idle", "idle", "idle"]);
    expect(states(true, all.slice(0, 5))).toEqual(["done", "done", "done", "active", "idle", "idle"]);
    expect(states(true, all.slice(0, 7))).toEqual(["done", "done", "done", "done", "active", "idle"]);
    expect(states(true, all)).toEqual(["done", "done", "done", "done", "done", "idle"]);
    // A review without regions never marks them, and the variant test is never part of a review.
    expect(states(true, all.slice(0, 6))).toEqual(["done", "done", "done", "done", "idle", "idle"]);
  });

  it("shows the real page count and any retry beside the matching step", () => {
    expect(reviewSteps(true, true, all.slice(0, 2))[1]).toEqual({ state: "active", note: "Running again after a retry" });
    expect(reviewSteps(true, true, all)[1]).toEqual({ state: "done", note: "6 pages cited, after one retry" });
    expect(reviewSteps(true, true, all)[2]).toEqual({ state: "done", note: "3 checked, 1 selected" });
    expect(reviewSteps(true, true, [{ stage: "research_started" }, { stage: "research_accepted", pages: 1 }, { stage: "cases_unavailable" }])[2]).toEqual({ state: "gap", note: "Could not be read" });
    expect(reviewSteps(true, true, [...all.slice(0, 5), { stage: "assessment_retried" }])[3]).toEqual({ state: "active", note: "Running again after a retry" });
  });
});

describe("review pipeline stage events", () => {
  const sequence = (...bodies: unknown[]) => {
    const fetcher = vi.fn<typeof fetch>();
    for (const value of bodies) fetcher.mockResolvedValueOnce(Response.json(value));
    return fetcher;
  };
  const registryRetriever = async () => ({ state: "available" as const, checkedCases: 3, matchedCaseIds: [], evidence: [], gaps: [] });
  async function run(fetcher: typeof fetch, extra: MetaOptions = {}, creative = input) {
    const events: ReviewProgress[] = [];
    const response = await reviewWithMeta(creative, { apiKey: "k", fetcher, registryRetriever, diagnostics: createReviewDiagnostics(() => undefined),
      onProgress: (event) => events.push(event), ...extra });
    return { response, events };
  }

  it("reports each stage once, in the order it happened, with real counts and no content", async () => {
    const { response, events } = await run(sequence(researchResponse(), assessmentResponse()));
    expect(response.state).toBe("completed");
    expect(events).toEqual([
      { stage: "research_started" }, { stage: "research_accepted", pages: 1 }, { stage: "cases_checked", checked: 3, selected: 0 }, { stage: "assessment_started" },
      { stage: "assessment_checked" },
    ]);
    for (const event of events) expect(reviewProgressSchema.safeParse(event).success).toBe(true);
    expect(JSON.stringify(events)).not.toContain(researchText.slice(0, 20));
  });

  it("reports a research retry between the two attempts", async () => {
    const unfinished = researchResponse(); unfinished.output.find((item) => item.type === "web_search_call")!.status = "searching";
    const { response, events } = await run(sequence(unfinished, researchResponse(), assessmentResponse()));
    expect(response.state).toBe("completed");
    expect(events.map((event) => event.stage)).toEqual(["research_started", "research_retried", "research_accepted", "cases_checked", "assessment_started", "assessment_checked"]);
  });

  it("reports an assessment retry", async () => {
    const bad = assessment(); bad.findings[0]!.sourceIds = ["S7"];
    const { events } = await run(sequence(researchResponse(), assessmentResponse(bad), assessmentResponse()));
    expect(events.map((event) => event.stage)).toEqual(["research_started", "research_accepted", "cases_checked", "assessment_started", "assessment_retried", "assessment_checked"]);
  });

  it("reports the registry as unavailable when it could not be read", async () => {
    const { events } = await run(sequence(researchResponse(), assessmentResponse()), { registryRetriever: async () => ({ state: "unavailable", code: "database_unavailable" }) });
    expect(events).toContainEqual({ stage: "cases_unavailable" });
  });

  it("reports how many named elements SAM 3.1 is asked to locate", async () => {
    const visual = assessment(true, "Ordinary copy"); visual.findings[0]!.visualConcept = "block";
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_, init) => {
      const request = JSON.parse(String(init?.body));
      if (request.model === "sam-3.1") return Response.json({ id: "s", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "" }] }] });
      return Response.json(request.tools ? researchResponse() : assessmentResponse(visual));
    });
    const image = { mediaType: "image/png" as const, dataUrl: "data:image/png;base64,AAAA", width: 800, height: 1000, uploadBytes: 3 };
    const { events } = await run(fetcher, {}, { ...input, copy: "Ordinary copy", image } as never);
    expect(events.slice(-2)).toEqual([{ stage: "regions_started", elements: 1 }, { stage: "regions_finished" }]);
  });

  it("never lets a failing listener change the review", async () => {
    const response = await reviewWithMeta(input, { apiKey: "k", fetcher: sequence(researchResponse(), assessmentResponse()), registryRetriever,
      diagnostics: createReviewDiagnostics(() => undefined), onProgress: () => { throw new Error("listener"); } });
    expect(response.state).toBe("completed");
  });
});

describe("streamed review route", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.doUnmock("@/server/meta"); vi.resetModules(); });
  let client = 0;
  function request(accept = "application/x-ndjson, application/json") {
    const form = new FormData();
    form.set("copy", "An ordinary cup of tea.");
    form.set("publicationDate", "2026-11-04");
    // Each test is its own client, so the per client request bound never interferes.
    return new Request("http://localhost/api/review", { method: "POST", body: form, headers: { accept, "x-forwarded-for": `198.51.100.${++client}` } });
  }
  async function lines(response: Response) {
    return (await response.text()).split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  }
  async function route(review: (input: unknown, options: MetaOptions) => Promise<ReviewResponse>) {
    vi.stubEnv("MODEL_API_KEY", "test-key");
    vi.resetModules();
    vi.doMock("@/server/meta", () => ({ reviewWithMeta: vi.fn(review) }));
    const routeModule = await import("@/app/api/review/route");
    const guard = await import("@/server/request-guard");
    return { POST: routeModule.POST, guard: guard.requestGuard };
  }

  it("streams an opening line, the stage events and one final result that passes the contract", async () => {
    const { POST, guard } = await route(async (_, options) => {
      options.onProgress?.({ stage: "research_started" });
      options.onProgress?.({ stage: "research_accepted", pages: 2 });
      return failed;
    });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(response.headers.get("cache-control")).toContain("no-transform");
    const parsed = await lines(response);
    expect(parsed.map((line) => line.type)).toEqual(["open", "progress", "progress", "result"]);
    expect(parsed.slice(1, 3).map((line) => line.event)).toEqual([{ stage: "research_started" }, { stage: "research_accepted", pages: 2 }]);
    expect(reviewResponseSchema.parse(parsed[3].response)).toEqual(failed);
    expect(guard.inFlight).toBe(0);
  });

  it("caps the stage events one stream can carry", async () => {
    const { POST } = await route(async (_, options) => {
      for (let index = 0; index < 20; index += 1) options.onProgress?.({ stage: "assessment_started" });
      return failed;
    });
    const parsed = await lines(await POST(request()));
    expect(parsed.filter((line) => line.type === "progress")).toHaveLength(MAX_PROGRESS_EVENTS);
    expect(parsed.at(-1).type).toBe("result");
  });

  it("cancelling the stream aborts the review and releases the request bound", async () => {
    let seen: AbortSignal | undefined;
    const { POST, guard } = await route((_, options) => new Promise((resolve) => {
      seen = options.signal;
      options.onProgress?.({ stage: "research_started" });
      options.signal!.addEventListener("abort", () => resolve({ state: "incomplete", result: null, issue: { code: "cancelled", message: "m", retryable: true } }));
    }));
    const response = await POST(request());
    const reader = response.body!.getReader();
    await reader.read();
    expect(guard.inFlight).toBe(1);
    await reader.cancel();
    await vi.waitFor(() => expect(seen?.aborted).toBe(true));
    await vi.waitFor(() => expect(guard.inFlight).toBe(0));
  });

  it("ends an unexpected failure with the same failed result the JSON reply gives", async () => {
    const { POST } = await route(async () => { throw new Error("boom"); });
    const parsed = await lines(await POST(request()));
    expect(parsed.at(-1)).toMatchObject({ type: "result", response: { state: "failed", issue: { code: "invalid_input" } } });
  });

  it("keeps the JSON reply and its status for a client that does not ask for a stream", async () => {
    const { POST } = await route(async () => failed);
    const response = await POST(request("application/json"));
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual(failed);
  });

  it("answers without a stream when live review is not configured", async () => {
    vi.stubEnv("MODEL_API_KEY", "");
    vi.resetModules();
    const { POST } = await import("@/app/api/review/route");
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});
