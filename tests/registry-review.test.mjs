import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRegistryRetriever, phrases } from "@/server/knowledge/review-context";
import { createKnowledgeRepository } from "@/server/knowledge/repository";
import { plainScope, reviewWithMeta, visiblePosterText } from "@/server/meta";
import { registryContextSchema, resultSchema, verifiedCaseSupport } from "@/lib/review-contract";
import { caseEvidenceSchema, knowledgeCaseSchema, caseTriggerSchema } from "@/server/knowledge/types";
import { buildManifest } from "../scripts/lib/three-case-intake.mjs";
import { assessment, assessmentResponse, input, researchResponse } from "./fixtures";

// Synthetic test data built from the fixed three-case intake manifest. No live output.
beforeEach(() => vi.spyOn(console, "info").mockImplementation(() => undefined));
afterEach(() => vi.restoreAllMocks());

const created_at = "2026-11-03T19:28:36.670Z";
function candidates() {
  const rows = buildManifest();
  return { state: "available", data: { truncated: false, cases: rows.knowledge_cases.map((row) => ({
    case: knowledgeCaseSchema.parse({ ...row, created_at }),
    evidence: rows.case_evidence.filter((entry) => entry.case_id === row.id).map((entry) => caseEvidenceSchema.parse({ ...entry, created_at, source: { ...rows.knowledge_sources.find((source) => source.id === entry.source_id), created_at } })),
    triggers: rows.case_triggers.filter((entry) => entry.case_id === row.id).map((entry) => caseTriggerSchema.parse({ ...entry, created_at })),
    complete: true,
  })) } };
}
const image = { mediaType: "image/png", dataUrl: "data:image/png;base64,dGVzdA==" };
function creative(copy, publicationDate = "2026-11-04", withImage = false) {
  return { ...input, copy, publicationDate, ...(withImage ? { image } : {}) };
}
async function select(value, visibleText = [], records = candidates(), matcher, report) {
  return createRegistryRetriever(async () => records)(value, visibleText, new AbortController().signal, matcher, report);
}
const ids = () => candidates().data.cases.map((item) => item.case.id);
const starbucks = creative("Tank Day tumbler: put it on your desk.", "2027-05-18");
const maple = creative("Angelic Buster update with a new hand frame emote.", "2023-12-01");
const gs = creative("Emotional Camping Must-have Item", "2021-05-11");
function fetchSequence(...responses) {
  const fetcher = vi.fn(); for (const response of responses) fetcher.mockResolvedValueOnce(Response.json(response)); return fetcher;
}
const withVisibleText = (lines) => { const raw = researchResponse(); raw.output.find((item) => item.type === "message").content[0].text += `\n<visible_text>${JSON.stringify(lines)}</visible_text>`; return raw; };

describe("data driven registry selection", () => {
  it("matches copy triggers in the submitted copy without a brand or hand written rule", async () => {
    const [tank, frame, camping] = ids();
    expect((await select(starbucks)).matchedCaseIds).toEqual([tank]);
    expect((await select(maple)).matchedCaseIds).toEqual([frame]);
    expect((await select(gs)).matchedCaseIds).toEqual([camping]);
    // Korean alternatives in a trigger match after NFKC normalization and case folding.
    expect((await select(creative("\ud140\ube14\ub7ec\ub97c \ucc45\uc0c1 \uc704\uc5d0 \ud0c1", "2027-05-18"))).matchedCaseIds).toEqual([tank]);
    for (const copy of ["A tank model for hobby day", "Starbucks coffee on May 18", "A friendly hand wave", "Camping snacks for a quiet evening"]) {
      expect((await select(creative(copy, "2027-05-18"))).matchedCaseIds).toEqual([]);
    }
  });

  it("matches copy triggers in the words read from the poster, only when a poster was submitted", async () => {
    const camping = ids()[2];
    const poster = creative("", "2021-05-11", true);
    const report = vi.fn();
    expect((await select(poster, ["EMOTIONAL CAMPING", "MUST-HAVE ITEM"], candidates(), async () => ({ state: "checked", caseIds: [] }), report)).matchedCaseIds).toEqual([camping]);
    expect(report.mock.calls[0][0].byKind).toMatchObject({ poster_text: 1, copy: 0 });
    expect((await select(creative("", "2021-05-11"), ["EMOTIONAL CAMPING MUST-HAVE ITEM"])).matchedCaseIds).toEqual([]);
    expect(phrases("Tank Day; \ucc45\uc0c1 \uc704\uc5d0 \ud0c1; ab")).toEqual(["tank day", "\ucc45\uc0c1 \uc704\uc5d0 \ud0c1"]);
  });

  it("matches a publication date trigger when the planned date falls inside its window", async () => {
    const camping = ids()[2];
    const report = vi.fn();
    expect((await select(creative("A plain spring sale", "2021-05-09"), [], candidates(), undefined, report)).matchedCaseIds).toEqual([camping]);
    expect(report.mock.calls[0][0].byKind.publication_date).toBe(1);
    expect((await select(creative("A plain spring sale", "2021-05-12"))).matchedCaseIds).toEqual([]);
  });

  it("checks imagery cues once, with cue text and an enum of case IDs only, for unselected cases", async () => {
    const records = candidates();
    for (const item of records.data.cases) {
      item.case.context_summary = "SUMMARY-SENTINEL";
      for (const trigger of item.triggers) trigger.description = "DESCRIPTION-SENTINEL";
      for (const entry of item.evidence) entry.assertion_text = `${entry.assertion_text} NOTE-SENTINEL`;
    }
    const matcher = vi.fn(async (list) => ({ state: "checked", caseIds: [list[0].caseId] }));
    const poster = creative("Emotional Camping Must-have Item", "2027-05-18", true);
    const selected = await select(poster, [], records, matcher);
    expect(matcher).toHaveBeenCalledTimes(1);
    const sent = matcher.mock.calls[0][0];
    // The camping case is already selected by its copy trigger, so only the other two are checked.
    expect(sent.map((item) => item.caseId)).toEqual(ids().slice(0, 2));
    expect(sent.every((item) => item.cues.length === 1)).toBe(true);
    expect(JSON.stringify(sent)).not.toMatch(/SENTINEL/);
    expect(selected.matchedCaseIds).toEqual(expect.arrayContaining([ids()[0], ids()[2]]));
    await select(creative("Emotional Camping Must-have Item", "2027-05-18"), [], candidates(), matcher);
    expect(matcher).toHaveBeenCalledTimes(1);
  });

  it("reports an imagery failure or a skipped check as a coverage gap, never as an unavailable registry", async () => {
    const poster = creative("", "2027-05-18", true);
    for (const [matcher, gap] of [[async () => ({ state: "failed" }), "imagery_check_unavailable"], [async () => { throw new Error("private detail"); }, "imagery_check_unavailable"],
      [async () => ({ state: "skipped" }), "imagery_check_skipped"], [undefined, "imagery_check_unavailable"]]) {
      const selected = await select(poster, [], candidates(), matcher);
      expect(selected).toMatchObject({ state: "available", matchedCaseIds: [], gaps: [gap] });
      expect(JSON.stringify(selected)).not.toContain("private");
    }
  });

  it("applies the temporal rules: same day, later, unknown date and model inference stay out", async () => {
    expect((await select({ ...starbucks, publicationDate: "2026-05-18" })).evidence).toEqual([]);
    expect((await select({ ...maple, publicationDate: "2023-11-26" })).evidence).toEqual([]);
    const sameDay = await select({ ...maple, publicationDate: "2023-11-30" });
    expect(sameDay.evidence).toHaveLength(1);
    expect(sameDay.evidence[0].assertionKind).toBe("reported_fact");
    const records = candidates();
    for (const entry of records.data.cases[2].evidence) entry.source.published_on = null;
    expect((await select(gs, [], records)).evidence).toEqual([]);
    const inference = candidates();
    inference.data.cases[0].evidence[0] = { ...inference.data.cases[0].evidence[0], assertion_kind: "model_inference", model_id: "synthetic-model" };
    expect((await select(starbucks, [], inference)).evidence.some((note) => note.evidenceId === inference.data.cases[0].evidence[0].id)).toBe(false);
  });

  it("keeps a whole eligible rebuttal and correction chain and never sends summaries or excerpts", async () => {
    const records = candidates();
    records.data.cases[1].case.context_summary = "FUTURE-SUMMARY-SENTINEL";
    records.data.cases[0].evidence[0].source_excerpt = "RESTRICTED-EXCERPT-SENTINEL";
    const selected = await select(maple, [], records);
    expect(selected.evidence).toHaveLength(4);
    const correction = selected.evidence.find((entry) => entry.assertionKind === "correction");
    expect(selected.evidence.some((entry) => entry.evidenceId === correction.relatedEvidenceId)).toBe(true);
    expect(selected.evidence.some((entry) => entry.assertionKind === "rebuttal")).toBe(true);
    expect(JSON.stringify(await select(starbucks, [], records))).not.toContain("SENTINEL");
    expect(JSON.stringify(selected)).not.toContain("SENTINEL");
  });

  it("admits any source that intake placed in the registry, with no fixed allowlist", async () => {
    const records = candidates();
    for (const entry of records.data.cases[0].evidence) entry.source.canonical_url = "https://news.example.org/intaken-later";
    const selected = await select(starbucks, [], records);
    expect(selected.evidence).toHaveLength(5);
    expect(selected.evidence.every((note) => note.canonicalUrl === "https://news.example.org/intaken-later")).toBe(true);
  });

  it("reports truncation as coverage gaps and sends each case whole or not at all", async () => {
    const truncated = candidates(); truncated.data.truncated = true;
    expect((await select(starbucks, [], truncated)).gaps).toEqual(["candidates_truncated"]);
    const partial = candidates(); partial.data.cases[0].complete = false;
    expect(await select(starbucks, [], partial)).toMatchObject({ matchedCaseIds: [], evidence: [], gaps: ["case_graph_truncated"] });
    // Four matching cases: three are sent, verified first, and the fourth is named as a gap.
    const many = candidates();
    const extra = structuredClone(many.data.cases[2]);
    extra.case = { ...extra.case, id: "00000000-0000-4000-8000-0000000000e1", case_key: "synthetic-extra" };
    many.data.cases.push(extra);
    many.data.cases[1].case.status = "verified";
    const copy = creative("Tank Day, Angelic Buster and Emotional Camping Must-have Item", "2027-05-18");
    const chosen = await select(copy, [], many);
    expect(chosen.matchedCaseIds).toHaveLength(3);
    expect(chosen.matchedCaseIds[0]).toBe(many.data.cases[1].case.id);
    expect(chosen.gaps).toEqual(["selected_cases_truncated"]);
    // A case whose notes would overflow the context is left out whole and named.
    const large = candidates();
    for (const entry of large.data.cases[0].evidence) entry.assertion_text = "x".repeat(3_900);
    for (const entry of large.data.cases[0].evidence) entry.attribution = "y".repeat(490);
    const big = await select(creative("Tank Day", "2027-05-18"), [], { state: "available", data: { truncated: false, cases: [large.data.cases[0], ...Array.from({ length: 3 }, (_, index) => ({ ...structuredClone(large.data.cases[0]), case: { ...large.data.cases[0].case, id: `00000000-0000-4000-8000-00000000001${index}`, case_key: `synthetic-large-${index}` } }))] } });
    expect(big.gaps).toContain("context_truncated");
    expect(new Set(big.evidence.map((note) => note.caseId)).size).toBe(big.matchedCaseIds.length);
    expect(registryContextSchema.safeParse(big).success).toBe(true);
  });

  it("reads a bounded set of emerging and verified cases with parameterized SQL and flags oversized graphs", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const repository = createKnowledgeRepository(async (operation) => ({ state: "available", data: await operation({ query }) }));
    expect(await repository.getReviewCandidates()).toEqual({ state: "available", data: { truncated: false, cases: [] } });
    expect(query.mock.calls[0][1]).toEqual(["KR", "emerging", "verified", 51, 20, 12]);
    expect(query.mock.calls[0][0]).toContain("LIMIT $4");
    expect(query.mock.calls[0][0]).not.toMatch(/case_key\s*=\s*ANY/);
    expect(() => repository.getReviewCandidates(51)).toThrow();
    const record = candidates().data.cases[0];
    const row = { record: record.case, evidence_count: 21, trigger_count: 3, evidence: record.evidence, triggers: record.triggers };
    query.mockResolvedValueOnce({ rows: Array.from({ length: 51 }, () => row) });
    const read = await repository.getReviewCandidates();
    expect(read.data.truncated).toBe(true);
    expect(read.data.cases).toHaveLength(50);
    expect(read.data.cases[0].complete).toBe(false);
  });

  it("distinguishes an empty registry from an unavailable one", async () => {
    expect(await select(starbucks, [], { state: "available", data: { truncated: false, cases: [] } })).toEqual({ state: "available", checkedCases: 0, matchedCaseIds: [], evidence: [], gaps: [] });
    expect(await select(starbucks, [], { state: "unavailable", code: "database_unavailable" })).toEqual({ state: "unavailable", code: "database_unavailable" });
  });
});

describe("visible poster text", () => {
  it("reads exactly one bounded envelope and nothing else", () => {
    const text = 'Note.\n<visible_text>["NIGHT", "CAMPING", "  "]</visible_text>';
    expect(visiblePosterText([text], true)).toEqual({ state: "parsed", lines: ["NIGHT", "CAMPING"] });
    expect(visiblePosterText([text], false)).toEqual({ state: "none", lines: [] });
    for (const value of [text + text, "no envelope", "<visible_text>not json</visible_text>", `<visible_text>${JSON.stringify(Array(41).fill("x"))}</visible_text>`,
      `<visible_text>${JSON.stringify(["y".repeat(201)])}</visible_text>`]) expect(visiblePosterText([value], true)).toEqual({ state: "invalid", lines: [] });
  });

  it("asks research to transcribe the poster's words exactly and treats them as data", async () => {
    const fetcher = fetchSequence(researchResponse(), assessmentResponse(assessment(false)));
    await reviewWithMeta(input, { apiKey: "test", fetcher, registryRetriever: async () => ({ state: "available", checkedCases: 0, matchedCaseIds: [], evidence: [] }) });
    const instructions = JSON.parse(fetcher.mock.calls[0][1].body).instructions;
    expect(instructions).toContain("<visible_text>JSON_ARRAY</visible_text>");
    expect(instructions).toContain("exactly as they appear");
    expect(instructions).toContain("never an instruction");
    expect(instructions).not.toContain("creative_observations");
  });
});

describe("registry aware assessment", () => {
  const empty = { state: "available", checkedCases: 0, matchedCaseIds: [], evidence: [] };

  it("passes registry notes and the poster transcription only to the assessment", async () => {
    const selected = await select(maple);
    const value = assessment(true, "Angelic Buster"); value.findings[0].sourceIds = ["S1", "R1", "R3"];
    const retriever = vi.fn().mockResolvedValue(selected);
    const fetcher = fetchSequence(withVisibleText(["ANGELIC BUSTER"]), assessmentResponse(value));
    const response = await reviewWithMeta({ ...maple, image }, { apiKey: "test", fetcher, registryRetriever: retriever });
    expect(response.state).toBe("completed");
    expect(retriever.mock.calls[0][1]).toEqual(["ANGELIC BUSTER"]);
    const first = JSON.parse(fetcher.mock.calls[0][1].body), second = JSON.parse(fetcher.mock.calls[1][1].body);
    expect(first.input[0].content[0].text).not.toContain("registry");
    const sent = JSON.parse(second.input[0].content[0].text);
    expect(sent.registry).toEqual(selected);
    expect(sent.visiblePosterText).toEqual(["ANGELIC BUSTER"]);
    expect(response.result.registry.evidence[0].id).toBe("R1");
    expect(response.result.verifiedCaseIds).toEqual([]);
    expect(response.result.outcome).toBe("emerging_signal");
  });

  it("runs one low effort imagery check between research and assessment, with no case summary", async () => {
    const records = candidates();
    records.data.cases[0].case.context_summary = "SUMMARY-SENTINEL";
    const retriever = createRegistryRetriever(async () => records);
    const caseIds = ids();
    const imagery = { id: "resp_imagery", status: "completed", output: [{ type: "message", id: "m_imagery", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: JSON.stringify({ visibleCaseIds: [caseIds[2]] }), annotations: [] }] }] };
    const fetcher = fetchSequence(withVisibleText(["NIGHT CAMPING"]), imagery, assessmentResponse(assessment(false)));
    const response = await reviewWithMeta(creative("", "2027-05-18", true), { apiKey: "test", fetcher, registryRetriever: retriever });
    expect(response.state).toBe("completed");
    expect(fetcher).toHaveBeenCalledTimes(3);
    const check = JSON.parse(fetcher.mock.calls[1][1].body);
    expect(check.reasoning).toEqual({ effort: "low" });
    expect(check).not.toHaveProperty("tools");
    expect(check.text.format).toMatchObject({ type: "json_schema", name: "registry_imagery_match", strict: true });
    expect(check.text.format.schema.properties.visibleCaseIds.items.enum).toEqual(caseIds);
    expect(check.input[0].content[1]).toEqual({ type: "input_image", image_url: image.dataUrl });
    expect(JSON.stringify(check)).not.toContain("SENTINEL");
    expect(response.result.registry.matchedCaseIds).toEqual([caseIds[2]]);
  });

  it("accepts a scoped empty registry but refuses a complete negative when unavailable", async () => {
    for (const [registry, expectedState] of [[empty, "completed"], [{ state: "unavailable", code: "database_unavailable" }, "incomplete"]]) {
      const fetcher = fetchSequence(researchResponse(), assessmentResponse(assessment(false)));
      const response = await reviewWithMeta(input, { apiKey: "test", fetcher, registryRetriever: async () => registry });
      expect(response.state).toBe(expectedState); expect(fetcher).toHaveBeenCalledTimes(2);
      if (response.state === "completed") expect(response.result.outcome).toBe("no_supported_concern_found");
      else expect(response).toMatchObject({ result: null, issue: { code: "retrieval_incomplete" } });
    }
  });

  it("names registry coverage gaps in the limitations", async () => {
    const response = await reviewWithMeta(input, { apiKey: "test", fetcher: fetchSequence(researchResponse(), assessmentResponse(assessment(false))),
      registryRetriever: async () => ({ ...empty, gaps: ["candidates_truncated", "imagery_check_unavailable"] }) });
    expect(response.state).toBe("completed");
    const text = response.result.limitations.join(" ");
    expect(text).toContain("Coverage gap. The registry holds more documented cases than one review reads");
    expect(text).toContain("selected by wording and date only");
  });

  it("rejects invented registry IDs and refuses a model or client that sets a verified case", async () => {
    const selected = await select(maple), value = assessment(); value.findings[0].sourceIds = ["R999"];
    const invented = fetchSequence(researchResponse(), assessmentResponse(value), assessmentResponse(value));
    expect(await reviewWithMeta(maple, { apiKey: "test", fetcher: invented, registryRetriever: async () => selected })).toMatchObject({ state: "failed", issue: { code: "invalid_response" } });
    expect(invented).toHaveBeenCalledTimes(3);
    const valid = await reviewWithMeta(maple, { apiKey: "test", fetcher: fetchSequence(researchResponse(), assessmentResponse()), registryRetriever: async () => selected });
    expect(resultSchema.safeParse({ ...valid.result, outcome: "evidence_backed_concern", verifiedCaseIds: [selected.matchedCaseIds[0]] }).success).toBe(false);
    expect(registryContextSchema.safeParse({ ...selected, evidence: [{ ...selected.evidence[0], annotation: { type: "url_citation" } }] }).success).toBe(false);
  });

  it("cancels during registry retrieval without starting the assessment request", async () => {
    const controller = new AbortController();
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    const retriever = createRegistryRetriever(() => { started(); return new Promise(() => undefined); });
    const fetcher = fetchSequence(researchResponse(), assessmentResponse());
    const pending = reviewWithMeta(input, { apiKey: "test", fetcher, registryRetriever: retriever, signal: controller.signal });
    await ready; controller.abort();
    expect(await pending).toMatchObject({ state: "incomplete", issue: { code: "cancelled" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("turns database exceptions into an explicit unavailable state without leaking details", async () => {
    const retriever = createRegistryRetriever(async () => { throw new Error("private connection details"); });
    const response = await retriever(input, [], new AbortController().signal);
    expect(response).toEqual({ state: "unavailable", code: "database_unavailable" });
    expect(JSON.stringify(response)).not.toContain("private");
  });
});

describe("server derived outcome", () => {
  async function verifiedContext(publicationDate = "2027-05-18") {
    const records = candidates();
    records.data.cases[0].case.status = "verified";
    return select(creative("Tank Day", publicationDate), [], records);
  }

  it("makes an evidence-backed concern only when a surviving finding cites a verified reported fact", async () => {
    const registry = await verifiedContext();
    const fact = registry.evidence.find((note) => note.assertionKind === "reported_fact");
    const rebuttal = registry.evidence.find((note) => note.assertionKind === "rebuttal");
    const cite = (sourceIds) => { const value = assessment(true, "Tank Day"); value.findings[0].sourceIds = sourceIds; value.findings[0].reactionSourceIds = ["S1"]; return value; };
    const run = (value) => reviewWithMeta(creative("Tank Day", "2027-05-18"), { apiKey: "test", fetcher: fetchSequence(researchResponse(), assessmentResponse(value)), registryRetriever: async () => registry });
    const backed = await run(cite(["S1", fact.id]));
    expect(backed.result.outcome).toBe("evidence_backed_concern");
    expect(backed.result.verifiedCaseIds).toEqual([fact.caseId]);
    expect(backed.result.summary).toContain("verified");
    const rebuttalOnly = await run(cite(["S1", rebuttal.id]));
    expect(rebuttalOnly.result.outcome).toBe("emerging_signal");
    expect(rebuttalOnly.result.verifiedCaseIds).toEqual([]);
    // A finding removed by the server cannot carry the outcome.
    const removed = cite(["S1", fact.id]); removed.findings[0].concernType = "pricing";
    expect((await run(removed)).result.outcome).toBe("no_supported_concern_found");
  });

  it("counts only reported facts that were available before the planned date", async () => {
    const registry = await verifiedContext();
    const fact = registry.evidence.find((note) => note.assertionKind === "reported_fact");
    expect(verifiedCaseSupport([{ sourceIds: [fact.id] }], registry, "2027-05-18")).toEqual([fact.caseId]);
    expect(verifiedCaseSupport([{ sourceIds: [fact.id] }], registry, fact.publishedOn)).toEqual([]);
    expect(verifiedCaseSupport([{ sourceIds: [fact.id] }], { state: "unavailable", code: "not_configured" }, "2027-05-18")).toEqual([]);
    const emerging = await select(creative("Tank Day", "2027-05-18"));
    expect(verifiedCaseSupport([{ sourceIds: emerging.evidence.map((note) => note.id) }], emerging, "2027-05-18")).toEqual([]);
  });
});

describe("poster wording and scope text", () => {
  const empty = { state: "available", checkedCases: 0, matchedCaseIds: [], evidence: [] };
  const posterFinding = (posterPhrase) => { const value = assessment(false); value.findings = [{ ...assessment().findings[0], elements: ["poster_text"], copyPhrase: "", posterPhrase }]; return value; };
  const run = (raw, value) => reviewWithMeta(creative("", "2026-11-04", true), { apiKey: "test", fetcher: fetchSequence(raw, assessmentResponse(value)), registryRetriever: async () => empty });

  it("keeps a poster wording finding only when its phrase is in the transcription", async () => {
    const kept = await run(withVisibleText(["EMOTIONAL CAMPING", "MUST-HAVE ITEM"]), posterFinding("emotional camping must-have"));
    expect(kept.result.findings).toHaveLength(1);
    const removed = await run(withVisibleText(["NIGHT CAMPING"]), posterFinding("emotional camping"));
    expect(removed.result.findings).toEqual([]);
    expect(removed.result.limitations.join(" ")).toContain("was not found in the text read from the poster. Leaving them out is not a finding that the creative is clear");
    const unread = await run(researchResponse(), posterFinding("emotional camping"));
    expect(unread.result.findings).toEqual([]);
    expect(unread.result.limitations.join(" ")).toContain("could not be read back reliably");
  });

  it("removes internal source IDs and summary wording from user facing scope text", async () => {
    expect(plainScope("Cited research summaries S1 and S2 (R1, R3) covered the wording.")).toBe("The cited sources covered the wording.");
    expect(plainScope("Sources S1-S3 describe the 2021 poster [R2].")).toBe("The cited sources describe the 2021 poster.");
    expect(plainScope("Research passages show no documented concern. Only S1 was dated.")).toBe("The cited sources show no documented concern. Only the cited source was dated.");
    expect(plainScope("Six cited pages and two documented cases were checked.")).toBe("Six cited pages and two documented cases were checked.");
    const value = assessment(false); value.evidenceScope = "Cited research summaries S1 and R2 were checked."; value.limitations = ["Only S1 was available."];
    const response = await reviewWithMeta(input, { apiKey: "test", fetcher: fetchSequence(researchResponse(), assessmentResponse(value)), registryRetriever: async () => empty });
    expect(response.result.scope.description).not.toMatch(/\b[SR][0-9]+\b|summar/i);
    expect(response.result.limitations.join(" ")).not.toMatch(/\bS1\b/);
    expect(response.result.sources[0].id).toBe("S1");
  });
});
