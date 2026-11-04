import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ASSESSMENT_RESERVE_MS, copyPhraseGrounded, foldForMatch, isEncyclopediaHost, resultSchema, sourceHost, type Assessment, type ReviewInput } from "@/lib/review-contract";
import { RESEARCH_RETRY_RESERVE_MS, SCOPE_LIMITATION, assessmentJsonSchema, dateDocumented, reviewWithMeta as reviewImplementation, type MetaOptions } from "@/server/meta";
import { createReviewDiagnostics } from "@/server/review-diagnostics";
import { assessment, assessmentResponse, input, researchResponse } from "./fixtures";

// Finding shapes follow the baseline runs named in each test. All text is a synthetic
// paraphrase for tests. No live output is stored.
beforeEach(() => vi.spyOn(console, "info").mockImplementation(() => undefined));
afterEach(() => vi.restoreAllMocks());

type Finding = Assessment["findings"][number];
const base = assessment().findings[0]!;
const finding = (overrides: Partial<Finding>): Finding => ({ ...base, ...overrides });
const sequence = (...responses: Array<{ body: unknown; status?: number }>) => {
  const fetcher = vi.fn<typeof fetch>();
  for (const response of responses) fetcher.mockResolvedValueOnce(Response.json(response.body, { status: response.status ?? 200 }));
  return fetcher;
};
const ok = (value: unknown) => ({ body: value });
const available = async () => ({ state: "available" as const, checkedCases: 3, matchedCaseIds: [], evidence: [] });
function review(creative: ReviewInput, fetcher: typeof fetch, options: MetaOptions = {}) {
  const lines: string[] = [];
  const diagnostics = createReviewDiagnostics((line) => lines.push(line));
  return reviewImplementation(creative, { apiKey: "k", fetcher, registryRetriever: available, diagnostics, ...options })
    .then((response) => ({ response, events: lines.map((line) => JSON.parse(line)), diagnostics }));
}
const image = { mediaType: "image/png" as const, dataUrl: "data:image/png;base64,AAAA", width: 800, height: 1000 };
// A completed result with one cited source, for result contract checks.
const resultShape = (url = "https://example.com/a") => ({ outcome: "emerging_signal", summary: "s", observations: [], verifiedCaseIds: [], limitations: [],
  searchCalls: [{ id: "w", status: "completed" }], scope: { market: "KR", publicationDate: "2026-12-01", checkedAt: "x", hasImage: false, hasCopy: true, completedSearches: 1, citedSources: 1, description: "d" },
  sources: [{ id: "S1", evidenceState: "unverified", responseId: "r", messageId: "m", blockIndex: 0, citedPassage: "p", annotation: { type: "url_citation", url, title: "t", start_index: 0, end_index: 1 } }],
  registry: { state: "available", checkedCases: 0, matchedCaseIds: [], evidence: [] } });

describe("observations that do not match the inputs", () => {
  it("relabels poster text reported as copy when no copy was submitted, and counts it", async () => {
    const data = assessment(false);
    data.observations = [{ kind: "copy", description: "The poster headline reads Leafloft." }, { kind: "image", description: "A potted plant." }];
    const { response, events } = await review({ ...input, copy: "", image }, sequence(ok(researchResponse()), ok(assessmentResponse(data))));
    if (response.state !== "completed") throw new Error(JSON.stringify(response));
    expect(response.result.observations.map((item) => item.kind)).toEqual(["image", "image"]);
    expect(events.find((event) => event.event === "assessment_checked")).toMatchObject({ result: "valid", observationsNormalized: 1 });
    expect(JSON.stringify(events)).not.toContain("Leafloft");
  });

  it("keeps a copy observation when copy was submitted", async () => {
    const { response, events } = await review(input, sequence(ok(researchResponse()), ok(assessmentResponse(assessment(false)))));
    if (response.state !== "completed") throw new Error(JSON.stringify(response));
    expect(response.result.observations[0]!.kind).toBe("copy");
    expect(events.find((event) => event.event === "assessment_checked")).toMatchObject({ observationsNormalized: 0 });
  });

  it("still rejects an image observation when no image was submitted, under its own category", async () => {
    const data = assessment(); data.observations[0]!.kind = "image";
    const { response, diagnostics } = await review(input, sequence(ok(researchResponse()), ok(assessmentResponse(data)), ok(assessmentResponse(data))));
    expect(response).toMatchObject({ state: "failed", issue: { code: "invalid_response" } });
    expect(diagnostics.failure).toBe("observation_input_mismatch");
  });

  it("names each other rejection with its own category", async () => {
    const url = assessment(); url.findings[0]!.reportedClaim = "See www.example.com for the claim.";
    const tooled = assessmentResponse(); (tooled.output as unknown[]).unshift({ type: "web_search_call", id: "w", status: "completed" });
    for (const [raw, category] of [[assessmentResponse({ nope: true }), "assessment_schema_invalid"], [assessmentResponse(url), "assessment_contains_url"], [tooled, "assessment_unexpected_output"]] as const) {
      const { response, diagnostics } = await review(input, sequence(ok(researchResponse()), ok(raw), ok(raw)));
      expect(response.state).toBe("failed");
      expect(diagnostics.failure).toBe(category);
    }
  });
});

describe("finding scope", () => {
  const run = async (findings: Finding[], creative: ReviewInput = input, registryRetriever: MetaOptions["registryRetriever"] = available) => {
    const data = assessment(false); data.findings = findings;
    return review(creative, sequence(ok(researchResponse()), ok(assessmentResponse(data))), { registryRetriever });
  };
  const shapes: Array<[string, Finding, string]> = [
    ["B05 free shipping", finding({ title: "Free shipping wording", concernType: "pricing", reportedClaim: "A legal explainer lists free shipping with added fees as a deceptive pattern." }), "removedOutOfScope"],
    ["B13 free eye test", finding({ title: "Free eye test wording", concernType: "pricing", reportedClaim: "A guide says eye tests are free only with a purchase." }), "removedOutOfScope"],
    ["B17 cooking time", finding({ title: "Mixed grain in 30 minutes", concernType: "product_or_performance_claim", reportedClaim: "One home test measured 64 minutes for mixed grain rice." }), "removedOutOfScope"],
    ["B17 food safety", finding({ title: "All day keep warm", concernType: "usage_or_safety", reportedClaim: "A report advises eating cooked rice within two hours." }), "removedOutOfScope"],
    ["B23 toothpaste efficacy", finding({ title: "Sensitive teeth wording", concernType: "legal_or_regulatory", reportedClaim: "A regulator found toothpaste ads with efficacy claims beyond approval." }), "removedOutOfScope"],
    ["B28 certification", finding({ title: "Children's product certification", concernType: "certification", reportedClaim: "Crayons for children fall under children's product certification." }), "removedOutOfScope"],
    ["B01 anniversary proximity", finding({ title: "Near a shelling anniversary", concernType: "historical_meaning", elements: ["date"],
      documentedDate: { start: "11-23", end: "11-23" }, reportedClaim: "A report describes memorials on the November 23 anniversary." }), "removedDateNotDocumented"],
  ];

  it.each(shapes)("removes the %s finding shape, notes it, and never claims the creative is clear", async (_, shape, counter) => {
    const { response, events } = await run([shape], { ...input, publicationDate: "2026-11-24" });
    if (response.state !== "completed") throw new Error(JSON.stringify(response));
    expect(response.result.findings).toEqual([]);
    expect(response.result.outcome).toBe("no_supported_concern_found");
    expect(response.result.summary).toContain("This is not a guarantee");
    expect(response.result.limitations).toContain(SCOPE_LIMITATION);
    expect(response.result.limitations.join(" ")).toMatch(/Leaving (it|them) out is not a finding that the (creative is clear|timing is clear)/);
    expect(events.find((event) => event.event === "assessment_checked")).toMatchObject({ [counter]: 1 });
  });

  it("removes findings without supplied reaction sources, without rejecting the review", async () => {
    const empty = finding({ title: "No reaction", reactionSourceIds: [] });
    const unsupplied = finding({ title: "Unsupplied reaction", reactionSourceIds: ["S9"] });
    const unlisted = finding({ title: "Reaction not cited by the finding", sourceIds: ["S1"], reactionSourceIds: ["R1"] });
    const { response, events } = await run([empty, unsupplied, unlisted]);
    if (response.state !== "completed") throw new Error(JSON.stringify(response));
    expect(response.result.findings).toEqual([]);
    expect(events.find((event) => event.event === "assessment_checked")).toMatchObject({ removedNoReactionSource: 3 });
  });

  it("keeps an in-scope finding whose reaction source documents the exact date", async () => {
    const tankDay = finding({ title: "Tank Day on May 18", concernType: "historical_meaning", elements: ["copy", "date"],
      documentedDate: { start: "05-18", end: "05-18" }, reportedClaim: "Critics objected to Tank Day wording on the May 18 anniversary." });
    const { response } = await run([tankDay], { ...input, publicationDate: "2027-05-18" });
    if (response.state !== "completed") throw new Error(JSON.stringify(response));
    expect(response.result.outcome).toBe("emerging_signal");
    expect(response.result.findings.map((item) => item.title)).toEqual(["Tank Day on May 18"]);
    expect(response.result.limitations).toContain(SCOPE_LIMITATION);
  });

  it("never turns removed findings into a negative review when the registry was unavailable", async () => {
    const { response } = await run([shapes[0]![1]], input, async () => ({ state: "unavailable", code: "database_unavailable" }));
    expect(response).toMatchObject({ state: "incomplete", result: null, issue: { code: "retrieval_incomplete" } });
  });

  it("the result contract refuses an out-of-scope finding or one without reaction sources", () => {
    const shape = resultShape();
    const accepted = resultSchema.safeParse({ ...shape, findings: [{ ...base, visualConcept: null }] });
    expect(accepted.success).toBe(true);
    expect(resultSchema.safeParse({ ...shape, findings: [{ ...base, visualConcept: null, concernType: "pricing" }] }).success).toBe(false);
    expect(resultSchema.safeParse({ ...shape, findings: [{ ...base, visualConcept: null, reactionSourceIds: [] }] }).success).toBe(false);
  });
});

describe("documented dates", () => {
  it("accepts the exact recurring or single date and a short period that contains it", () => {
    expect(dateDocumented({ start: "05-18", end: "05-18" }, "2027-05-18")).toBe(true);
    expect(dateDocumented({ start: "2026-06-03", end: "2026-06-03" }, "2026-06-03")).toBe(true);
    expect(dateDocumented({ start: "12-30", end: "01-02" }, "2027-01-01")).toBe(true);
    expect(dateDocumented({ start: "06-01", end: "06-30" }, "2026-06-25")).toBe(true);
  });
  it("refuses proximity, broad seasons, invalid values and mixed formats", () => {
    expect(dateDocumented({ start: "11-23", end: "11-23" }, "2026-11-24")).toBe(false);
    expect(dateDocumented({ start: "11-01", end: "12-31" }, "2026-11-24")).toBe(false);
    expect(dateDocumented({ start: "", end: "" }, "2026-11-24")).toBe(false);
    expect(dateDocumented({ start: "02-30", end: "02-30" }, "2026-02-28")).toBe(false);
    expect(dateDocumented({ start: "11-24", end: "2026-11-24" }, "2026-11-24")).toBe(false);
    expect(dateDocumented({ start: "2026-11-25", end: "2026-11-23" }, "2026-11-24")).toBe(false);
  });
});

describe("research retry", () => {
  const unfinished = () => { const raw = researchResponse(); raw.output.find((item) => item.type === "web_search_call")!.status = "searching"; return raw; };
  const uncited = () => researchResponse({ citations: false });
  const invalidCitations = () => { const raw = researchResponse(); raw.output.find((item) => item.type === "message")!.content![0]!.annotations![0]!.url = "javascript:invalid"; return raw; };

  it.each([["an unfinished search", unfinished, "unfinished_search_items"], ["an incomplete envelope", () => researchResponse({ status: "incomplete" }), "provider_research_envelope_incomplete"],
    ["missing citations", uncited, "missing_citations"]] as const)(
    "retries once after %s and completes with every guard applied", async (_, failing, reason) => {
      const fetcher = sequence(ok(failing()), ok(researchResponse()), ok(assessmentResponse()));
      const { response, events, diagnostics } = await review(input, fetcher);
      expect(response.state).toBe("completed");
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(events.filter((event) => event.event === "research_retried")).toEqual([expect.objectContaining({ reason })]);
      expect(events.filter((event) => event.event === "provider_started" && event.stage === "research")).toHaveLength(2);
      // The first attempt's failure does not survive a successful retry.
      expect(diagnostics.failure).toBeUndefined();
    });

  it("never retries more than once", async () => {
    const fetcher = sequence(ok(unfinished()), ok(unfinished()), ok(assessmentResponse()));
    const { response, diagnostics } = await review(input, fetcher);
    expect(response).toMatchObject({ state: "incomplete", issue: { code: "retrieval_incomplete" } });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(diagnostics.failure).toBe("unfinished_search_items");
  });

  it("keeps the citation guard when the retry also lacks citations", async () => {
    const registryRetriever = vi.fn(available);
    const fetcher = sequence(ok(uncited()), ok(uncited()), ok(assessmentResponse()));
    const { response, events, diagnostics } = await review(input, fetcher, { registryRetriever });
    expect(response).toMatchObject({ state: "incomplete", result: null, issue: { code: "insufficient_sources" } });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(registryRetriever).not.toHaveBeenCalled();
    expect(events.filter((event) => event.event === "research_retried")).toEqual([expect.objectContaining({ reason: "missing_citations" })]);
    expect(diagnostics.failure).toBe("missing_citations");
    expect(events.at(-1)).toMatchObject({ event: "research_checked", result: "rejected", category: "missing_citations" });
  });

  it.each([
    ["invalid citations", () => ok(invalidCitations())],
    ["no search at all", () => ok(researchResponse({ search: false }))],
    ["rejected credentials", () => ({ body: {}, status: 401 })],
    ["a quota error", () => ({ body: {}, status: 429 })],
    ["a provider failure", () => ({ body: {}, status: 500 })],
  ] as const)("does not retry after %s", async (_, failing) => {
    const fetcher = sequence(failing(), ok(researchResponse()), ok(assessmentResponse()));
    const { response, events } = await review(input, fetcher);
    expect(response.state).not.toBe("completed");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.event === "research_retried")).toBe(false);
  });

  it("does not retry after a cancellation", async () => {
    const stop = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => { stop.abort(); return Response.json(unfinished()); });
    const { response } = await review(input, fetcher, { signal: stop.signal });
    expect(response).toMatchObject({ state: "incomplete", issue: { code: "cancelled" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([["an unfinished search", unfinished], ["missing citations", uncited]] as const)(
    "starts a retry after %s only when the shared deadline still holds a research call and an assessment", async (_, failing) => {
    expect(RESEARCH_RETRY_RESERVE_MS).toBe(140_000);
    const short = sequence(ok(failing()), ok(researchResponse()), ok(assessmentResponse()));
    const tight = await review(input, short, { timeoutMs: RESEARCH_RETRY_RESERVE_MS + 3_000 - 1_000 });
    expect(tight.response.state).toBe("incomplete");
    expect(short).toHaveBeenCalledTimes(1);
    const roomy = sequence(ok(failing()), ok(researchResponse()), ok(assessmentResponse()));
    const enough = await review(input, roomy, { timeoutMs: RESEARCH_RETRY_RESERVE_MS + 3_000 + 5_000 });
    expect(enough.response.state).toBe("completed");
    expect(enough.events.find((event) => event.event === "research_retried")!.remainingMs).toBeGreaterThanOrEqual(RESEARCH_RETRY_RESERVE_MS);
  });
});

describe("source ID enums and unknown references", () => {
  it("limits every source ID field to the IDs supplied to this assessment", async () => {
    const fetcher = sequence(ok(researchResponse()), ok(assessmentResponse()));
    await review(input, fetcher);
    const body = JSON.parse(String(fetcher.mock.calls[1]![1]?.body));
    const finding = body.text.format.schema.properties.findings.items.properties;
    expect(finding.sourceIds.items).toEqual({ type: "string", enum: ["S1"] });
    expect(finding.reactionSourceIds.items).toEqual({ type: "string", enum: ["S1"] });
    expect(body.text.format.strict).toBe(true);
    expect(assessmentJsonSchema(["S1", "S2", "R1"]).properties.findings.items.properties.sourceIds!.items).toEqual({ type: "string", enum: ["S1", "S2", "R1"] });
  });

  it("counts unknown IDs by field and shape without logging them, and keeps the server check", async () => {
    const data = assessment(); data.findings[0]!.sourceIds = ["S1", "S9", "R4", "Z-PRIVATE"]; data.findings[0]!.reactionSourceIds = ["S1"];
    const { response, events } = await review(input, sequence(ok(researchResponse()), ok(assessmentResponse(data)), ok(assessmentResponse(data))));
    expect(response).toMatchObject({ state: "failed", issue: { code: "invalid_response" } });
    expect(events.filter((event) => event.event === "unknown_source_ids")[0]).toEqual(expect.objectContaining({ field: "sourceIds", S: 1, R: 1, other: 1 }));
    expect(JSON.stringify(events)).not.toMatch(/S9|R4|Z-PRIVATE/);
  });
});

describe("assessment retry", () => {
  const bad = () => { const data = assessment(); data.findings[0]!.sourceIds = ["S7"]; return assessmentResponse(data); };

  it.each([["an unknown source reference", bad, "unknown_source_reference"], ["invalid structured output", () => assessmentResponse({ nope: true }), "assessment_schema_invalid"]] as const)(
    "retries once after %s and completes when the retry is valid", async (_, failing, reason) => {
      const fetcher = sequence(ok(researchResponse()), ok(failing()), ok(assessmentResponse()));
      const { response, events, diagnostics } = await review(input, fetcher);
      expect(response.state).toBe("completed");
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(events.filter((event) => event.event === "assessment_retried")).toEqual([expect.objectContaining({ reason })]);
      expect(diagnostics.failure).toBeUndefined();
    });

  it("keeps the rejection when the retry also fails, and never retries twice", async () => {
    const fetcher = sequence(ok(researchResponse()), ok(bad()), ok(bad()), ok(assessmentResponse()));
    const { response } = await review(input, fetcher);
    expect(response).toMatchObject({ state: "failed", issue: { code: "invalid_response" } });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("does not retry an insufficient assessment, a provider error or an unfinished assessment envelope", async () => {
    const insufficient = assessment(false); insufficient.assessmentStatus = "insufficient"; insufficient.insufficientReason = "conflicting_evidence";
    for (const second of [ok(assessmentResponse(insufficient)), { body: {}, status: 500 }, ok({ ...assessmentResponse(), status: "incomplete" })]) {
      const fetcher = sequence(ok(researchResponse()), second, ok(assessmentResponse()));
      const { response, events } = await review(input, fetcher);
      expect(response.state).not.toBe("completed");
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(events.some((event) => event.event === "assessment_retried")).toBe(false);
    }
  });

  it("starts an assessment retry only when the shared deadline still holds an assessment", async () => {
    expect(ASSESSMENT_RESERVE_MS).toBe(50_000);
    expect(RESEARCH_RETRY_RESERVE_MS).toBe(140_000);
    const tightFetcher = sequence(ok(researchResponse()), ok(bad()), ok(assessmentResponse()));
    const tight = await review(input, tightFetcher, { timeoutMs: ASSESSMENT_RESERVE_MS + 3_000 - 1_000 });
    expect(tight.response.state).toBe("failed");
    expect(tightFetcher).toHaveBeenCalledTimes(2);
    const roomyFetcher = sequence(ok(researchResponse()), ok(bad()), ok(assessmentResponse()));
    const roomy = await review(input, roomyFetcher, { timeoutMs: ASSESSMENT_RESERVE_MS + 3_000 + 5_000 });
    expect(roomy.response.state).toBe("completed");
  });
});

describe("insufficient assessments", () => {
  it("asks for a complete scoped negative when cited research shows no documented concern", async () => {
    const fetcher = sequence(ok(researchResponse()), ok(assessmentResponse(assessment(false))));
    const { response } = await review(input, fetcher);
    const instructions = JSON.parse(String(fetcher.mock.calls[1]![1]?.body)).instructions as string;
    expect(instructions).toContain("return assessmentStatus=complete with an empty");
    expect(instructions).toContain("insufficientReason conflicting_evidence");
    if (response.state !== "completed") throw new Error(JSON.stringify(response));
    expect(response.result.outcome).toBe("no_supported_concern_found");
    expect(response.result.summary).toContain("This is not a guarantee");
    expect(response.result.limitations).toContain(SCOPE_LIMITATION);
  });

  it.each(["conflicting_evidence", "creative_not_assessable"] as const)("records the %s reason and stays incomplete", async (reason) => {
    const data = assessment(false); data.assessmentStatus = "insufficient"; data.insufficientReason = reason;
    const { response, events } = await review(input, sequence(ok(researchResponse()), ok(assessmentResponse(data))));
    expect(response).toMatchObject({ state: "incomplete", issue: { code: "assessment_incomplete" } });
    expect(events.find((event) => event.event === "assessment_insufficient")).toEqual(expect.objectContaining({ reason }));
  });

  it("still refuses a complete negative when the registry was unavailable", async () => {
    const { response } = await review(input, sequence(ok(researchResponse()), ok(assessmentResponse(assessment(false)))),
      { registryRetriever: async () => ({ state: "unavailable", code: "database_unavailable" }) });
    expect(response).toMatchObject({ state: "incomplete", issue: { code: "retrieval_incomplete" } });
  });
});

describe("reaction source quality", () => {
  const run = async (findings: Finding[]) => {
    const data = assessment(false); data.findings = findings;
    return review({ ...input, image }, sequence(ok(researchResponse()), ok(assessmentResponse(data))));
  };
  // Shapes of the B28 and B06 findings from the 2026-11-04 validation run.
  const b28 = finding({ title: "Party colors in crayons", concernType: "social_meaning", elements: ["image"], visualConcept: "crayons",
    reactionKind: "general_guide_or_symbol_explanation", visualMatch: "color_only", reportedClaim: "Political parties in South Korea are linked to specific colors." });
  const b06 = finding({ title: "Small pinched shape", concernType: "social_meaning", elements: ["image"], visualConcept: "icon",
    reactionKind: "reaction_to_advertisement_or_campaign", visualMatch: "ambiguous_shape", reportedClaim: "A 2021 ad dispute concerned a pinching hand." });

  it.each([
    ["B28, a symbol explanation about colors", b28, "removedWeakReaction"],
    ["B28, colors alone even with a documented reaction", finding({ ...b28, reactionKind: "reaction_to_other_public_use" }), "removedVisualMatch"],
    ["B06, an ambiguous shape read as a gesture", b06, "removedVisualMatch"],
  ] as const)("removes %s and does not claim the creative is clear", async (_, shape, counter) => {
    const { response, events } = await run([shape]);
    if (response.state !== "completed") throw new Error(JSON.stringify(response));
    expect(response.result.findings).toEqual([]);
    expect(response.result.outcome).toBe("no_supported_concern_found");
    expect(response.result.limitations.join(" ")).toContain("Leaving them out is not a finding that the creative is clear");
    expect(events.find((event) => event.event === "assessment_checked")).toMatchObject({ [counter]: 1 });
  });

  it("keeps a clear visible match backed by a documented reaction to an advertisement", async () => {
    const hand = finding({ title: "Hand pinching food", concernType: "social_meaning", elements: ["image"], visualConcept: "hand",
      reactionKind: "reaction_to_advertisement_or_campaign", visualMatch: "clear_visible_match", reportedClaim: "A 2021 poster with a hand near a sausage drew backlash." });
    const { response } = await run([hand]);
    if (response.state !== "completed") throw new Error(JSON.stringify(response));
    expect(response.result.findings.map((item) => item.title)).toEqual(["Hand pinching food"]);
  });

  it("states the color and shape rules in the instructions", async () => {
    const fetcher = sequence(ok(researchResponse()), ok(assessmentResponse(assessment(false))));
    await review(input, fetcher);
    const instructions = JSON.parse(String(fetcher.mock.calls[1]![1]?.body)).instructions as string;
    expect(instructions).toContain("Never infer a political party association from colors alone.");
    expect(instructions).toContain("Never treat an ambiguous shape as a gesture or symbol");
    expect(instructions).toContain("General guides, etiquette lists and symbol explanations are not");
  });
});

describe("copy grounding", () => {
  const run = async (creative: ReviewInput, findings: Finding[]) => {
    const data = assessment(false); data.findings = findings;
    return review(creative, sequence(ok(researchResponse()), ok(assessmentResponse(data))));
  };
  // Shapes of the desk wording (P1) and finger frame (P2) findings from the 2026-11-04 stop
  // cause run. The copy and claims are synthetic paraphrases.
  const tankCopy = "\ud0f1\ud06c \ub370\uc774. \ud140\ube14\ub7ec\ub97c \ucc45\uc0c1 \uc704\uc5d0 \uc62c\ub824\ub450\uace0 \uc778\uc99d\ud558\uc138\uc694.";
  const desk = (copyPhrase: string) => finding({ title: "Desk wording on Tank Day", concernType: "historical_meaning", elements: ["copy"], copyPhrase,
    reportedClaim: "Critics linked desk tapping wording in a coffee promotion to a 1987 cover-up statement." });
  const frameCopy = "Aetherwing winter update. The heroine makes a finger frame in the new promotional clip.";
  const frame = (copyPhrase: string) => finding({ title: "Finger frame gesture", concernType: "social_meaning", elements: ["copy"], copyPhrase,
    reportedClaim: "A 2023 game trailer drew complaints about a pinching hand gesture." });

  it.each([
    ["tapping wording the Korean copy does not contain", tankCopy, desk("\ucc45\uc0c1\uc744 \ud0c1")],
    ["tapping wording the English copy does not contain", "Tank Day. Set your tumbler on the desk and share a photo.", desk("tap it on the desk")],
    ["a pinch the finger frame copy does not mention", frameCopy, frame("pinching gesture")],
    ["an empty phrase", frameCopy, frame("")],
    ["a phrase when no copy was submitted", "", frame("finger frame")],
  ] as const)("removes a copy finding that relies on %s, with the removal note", async (_, copy, shape) => {
    const { response, events } = await run({ ...input, copy, ...(copy ? {} : { image }) }, [shape]);
    if (response.state !== "completed") throw new Error(JSON.stringify(response));
    expect(response.result.findings).toEqual([]);
    expect(response.result.outcome).toBe("no_supported_concern_found");
    expect(response.result.limitations.join(" ")).toContain("does not appear in the submitted copy. Leaving them out is not a finding that the creative is clear");
    expect(events.find((event) => event.event === "assessment_checked")).toMatchObject({ removedCopyNotGrounded: 1 });
  });

  it.each([
    ["the Korean desk phrase the copy contains", tankCopy, desk("\ud140\ube14\ub7ec\ub97c \ucc45\uc0c1 \uc704\uc5d0")],
    ["the finger frame phrase in another letter case", frameCopy, frame("FINGER FRAME")],
    ["the finger frame phrase in full-width characters", frameCopy, frame("\uff46\uff49\uff4e\uff47\uff45\uff52\u3000\uff46\uff52\uff41\uff4d\uff45")],
  ] as const)("keeps a copy finding that quotes %s", async (_, copy, shape) => {
    const { response, events } = await run({ ...input, copy }, [shape]);
    if (response.state !== "completed") throw new Error(JSON.stringify(response));
    expect(response.result.findings.map((item) => item.title)).toEqual([shape.title]);
    expect(events.find((event) => event.event === "assessment_checked")).toMatchObject({ removedCopyNotGrounded: 0 });
  });

  it("compares after NFKC normalization and case folding", () => {
    expect(foldForMatch("\uff46\uff49\uff4e\uff47\uff45\uff52\u3000\uff46\uff52\uff41\uff4d\uff45")).toBe("finger frame");
    expect(copyPhraseGrounded("GROSSE AKTION", "Gro\u00dfe Aktion")).toBe(true);
    expect(copyPhraseGrounded("finger  frame", frameCopy)).toBe(false);
    expect(copyPhraseGrounded("   ", frameCopy)).toBe(false);
  });

  it("asks for the exact phrase, and the result contract refuses a copy finding without one", async () => {
    const fetcher = sequence(ok(researchResponse()), ok(assessmentResponse(assessment(false))));
    await review(input, fetcher);
    const instructions = JSON.parse(String(fetcher.mock.calls[1]![1]?.body)).instructions as string;
    expect(instructions).toContain("set copyPhrase to the exact words of advertisementCopy");
    const shape = resultShape();
    expect(resultSchema.safeParse({ ...shape, findings: [{ ...base, visualConcept: null }] }).success).toBe(true);
    expect(resultSchema.safeParse({ ...shape, findings: [{ ...base, visualConcept: null, copyPhrase: "" }] }).success).toBe(false);
    expect(resultSchema.safeParse({ ...shape, scope: { ...shape.scope, hasCopy: false }, findings: [{ ...base, visualConcept: null }] }).success).toBe(false);
  });
});

describe("encyclopedia reaction sources", () => {
  // S1 is the first cited span and S2 the second, in annotation order.
  const twoSources = (first: string) => {
    const raw = researchResponse();
    const text = "An encyclopedia entry lists the dispute. A news report describes the public reaction.";
    const split = text.indexOf(" A news");
    raw.output = raw.output.map((item) => item.type !== "message" ? item : { ...item, content: [{ type: "output_text", text, annotations: [
      { type: "url_citation", url: first, title: "Synthetic entry", start_index: 0, end_index: split },
      { type: "url_citation", url: "https://news.example.com/report", title: "Synthetic report", start_index: split + 1, end_index: text.length },
    ] }] }) as typeof raw.output;
    return raw;
  };
  const run = async (findings: Finding[], first = "https://en.wikipedia.org/wiki/Synthetic_entry", options: MetaOptions = {}) => {
    const data = assessment(false); data.findings = findings;
    const fetcher = sequence(ok(twoSources(first)), ok(assessmentResponse(data)));
    return { ...(await review(input, fetcher, options)), fetcher };
  };
  const cited = (reactionSourceIds: string[], sourceIds = ["S1", "S2"]) => finding({ title: "Documented reaction", sourceIds, reactionSourceIds });

  it.each(["https://en.wikipedia.org/wiki/Synthetic_entry", "https://ko.m.wikipedia.org/wiki/Synthetic_entry", "https://namu.wiki/w/Synthetic_entry"])(
    "removes a finding whose only reaction source is the encyclopedia page %s", async (url) => {
      const { response, events } = await run([cited(["S1"])], url);
      if (response.state !== "completed") throw new Error(JSON.stringify(response));
      expect(response.result.findings).toEqual([]);
      expect(response.result.outcome).toBe("no_supported_concern_found");
      expect(response.result.limitations.join(" ")).toContain("only encyclopedia pages document the reaction. Leaving them out is not a finding that the creative is clear");
      expect(events.find((event) => event.event === "assessment_checked")).toMatchObject({ removedEncyclopediaOnly: 1 });
    });

  it("keeps a finding when a source other than an encyclopedia also documents the reaction", async () => {
    for (const reactionSourceIds of [["S1", "S2"], ["S2"]]) {
      const { response, events } = await run([cited(reactionSourceIds)]);
      if (response.state !== "completed") throw new Error(JSON.stringify(response));
      expect(response.result.findings).toHaveLength(1);
      expect(events.find((event) => event.event === "assessment_checked")).toMatchObject({ removedEncyclopediaOnly: 0 });
    }
  });

  it("checks registry notes by their canonical host and never sends hosts to the assessment", async () => {
    const caseId = "00000000-0000-4000-8000-000000000001";
    const note = { id: "R1", caseId, evidenceId: "00000000-0000-4000-8000-000000000002", caseStatus: "emerging" as const, sourceId: "00000000-0000-4000-8000-000000000003",
      canonicalUrl: "https://en.wikipedia.org/wiki/Registry_entry", title: "Registry entry", publisher: null, publishedOn: "2021-05-03", availableAt: "2021-05-03T00:00:00Z",
      assertionKind: "reported_fact" as const, assertionText: "A synthetic registry note.", attribution: "Synthetic attribution", provenance: "Synthetic provenance", relatedEvidenceId: null };
    const registryRetriever = async () => ({ state: "available" as const, checkedCases: 3, matchedCaseIds: [caseId], evidence: [note] });
    const { response, events, fetcher } = await run([cited(["R1"], ["S2", "R1"])], "https://en.wikipedia.org/wiki/Synthetic_entry", { registryRetriever });
    if (response.state !== "completed") throw new Error(JSON.stringify(response));
    expect(response.result.findings).toEqual([]);
    expect(events.find((event) => event.event === "assessment_checked")).toMatchObject({ removedEncyclopediaOnly: 1 });
    const sent = JSON.parse(JSON.parse(String(fetcher.mock.calls[1]![1]?.body)).input[0].content[0].text);
    expect(sent.citedResearch.map((source: object) => Object.keys(source).sort())).toEqual([["citedPassage", "evidenceState", "sourceId", "title"], ["citedPassage", "evidenceState", "sourceId", "title"]]);
    expect(JSON.stringify(sent.citedResearch)).not.toContain("wikipedia");
  });

  it("matches encyclopedia hosts and their subdomains only", () => {
    for (const host of ["wikipedia.org", "ko.wikipedia.org", "EN.M.WIKIPEDIA.ORG.", "namu.wiki", "www.britannica.com", "encykorea.aks.ac.kr", "terms.naver.com"]) expect(isEncyclopediaHost(host)).toBe(true);
    for (const host of ["wikitree.co.kr", "notwikipedia.org", "wikipedia.org.example.com", "namu.news", "news.naver.com", ""]) expect(isEncyclopediaHost(host)).toBe(false);
    expect(sourceHost("https://ko.wikipedia.org/wiki/X")).toBe("ko.wikipedia.org");
    expect(sourceHost("not a url")).toBe("");
  });

  it("the result contract refuses a finding whose only reaction sources are encyclopedia pages", () => {
    const shape = resultShape("https://en.wikipedia.org/wiki/Synthetic_entry");
    expect(resultSchema.safeParse({ ...shape, findings: [{ ...base, visualConcept: null }] }).success).toBe(false);
    expect(resultSchema.safeParse({ ...resultShape(), findings: [{ ...base, visualConcept: null }] }).success).toBe(true);
  });
});
