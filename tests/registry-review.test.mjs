import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectRegistryContext, observedFeatures, createRegistryRetriever, REVIEW_CASE_KEYS } from "@/server/knowledge/review-context";
import { createKnowledgeRepository } from "@/server/knowledge/repository";
import { reviewWithMeta } from "@/server/meta";
import { registryContextSchema, resultSchema } from "@/lib/review-contract";
import { caseEvidenceSchema, knowledgeCaseSchema, caseTriggerSchema } from "@/server/knowledge/types";
import { buildManifest } from "../scripts/lib/three-case-intake.mjs";
import { assessment, assessmentResponse, input, researchResponse } from "./fixtures";

beforeEach(() => vi.spyOn(console, "info").mockImplementation(() => undefined));
afterEach(() => vi.restoreAllMocks());

const now = new Date("2026-11-03T20:00:00Z");
const created_at = "2026-11-03T19:28:36.670Z";
function candidates() {
  const rows = buildManifest();
  return { state: "available", data: rows.knowledge_cases.map((row) => ({
    case: knowledgeCaseSchema.parse({ ...row, created_at }),
    evidence: rows.case_evidence.filter((entry) => entry.case_id === row.id).map((entry) => caseEvidenceSchema.parse({ ...entry, created_at, source: { ...rows.knowledge_sources.find((source) => source.id === entry.source_id), created_at } })),
    triggers: rows.case_triggers.filter((entry) => entry.case_id === row.id).map((entry) => caseTriggerSchema.parse({ ...entry, created_at })),
  })) };
}
function creative(copy, publicationDate = "2026-11-04", image = false) {
  return { ...input, copy, publicationDate, ...(image ? { image: { mediaType: "image/png", dataUrl: "data:image/png;base64,dGVzdA==" } } : {}) };
}
function select(value, features = [], records = candidates()) { return selectRegistryContext(value, features, records, now); }
const starbucks = creative("Starbucks Tank Day tumbler: on your desk.", "2027-05-18");
const maple = creative("MapleStory Angelic Buster: review this hand gesture frame.", "2023-12-01");
const gs = creative("GS25 Emotional Camping Must-have Item", "2021-05-11");
const empty = { state: "available", checkedCases: 0, matchedCaseIds: [], evidence: [] };
function fetchSequence(...responses) {
  const fetcher = vi.fn(); for (const response of responses) fetcher.mockResolvedValueOnce(Response.json(response)); return fetcher;
}

describe("bounded contextual registry selection", () => {
  it("matches Starbucks promotion wording with May 18 context, not unrelated dates", () => {
    expect(select(starbucks).evidence).toHaveLength(5);
    expect(select({ ...starbucks, publicationDate: "2027-05-19" }).matchedCaseIds).toEqual([]);
    expect(select(starbucks).matchedCaseIds).toEqual([candidates().data[0].case.id]);
  });
  it("supports Korean brand, promotion and product copy", () => {
    const copy = "\uc2a4\ud0c0\ubc85\uc2a4 \ud0f1\ud06c \ub370\uc774 \ud140\ube14\ub7ec";
    expect(select(creative(copy, "2027-05-18")).evidence).toHaveLength(5);
    expect(select(creative("\uba54\uc774\ud50c\uc2a4\ud1a0\ub9ac \uc5d4\uc824\ub9ad\ubc84\uc2a4\ud130 \uc190\ubaa8\uc591", "2023-12-01")).evidence).toHaveLength(4);
    expect(select(creative("GS25 \ucea0\ud551 \ud3ec\uc2a4\ud130 \uc190\uac00\ub77d", "2021-05-11")).evidence).toHaveLength(5);
  });
  it("requires production context and observed creative features for visual matching", () => {
    const value = creative("MapleStory Angelic Buster summer update", "2023-12-01", true);
    expect(select(value).evidence).toEqual([]);
    expect(select(value, ["thumb_index_near"]).evidence).toEqual([]);
    expect(select(value, ["thumb_index_near", "animated_character"]).evidence).toHaveLength(4);
    expect(select(creative("A friendly hand illustration", "2023-12-01", true), ["thumb_index_near", "animated_character"]).evidence).toEqual([]);
    expect(select({ ...value, image: undefined }, ["thumb_index_near", "animated_character"]).evidence).toEqual([]);
  });
  it("matches specific GS25 poster context while excluding benign overlapping words", () => {
    expect(select(gs).evidence).toHaveLength(5);
    for (const copy of ["GS25 camping snacks for a quiet evening", "A tank model on the desk for hobby day", "Starbucks coffee on May 18", "MapleStory and a friendly hand wave"]) {
      expect(select(creative(copy, "2027-05-18", true), ["thumb_index_near"]).evidence).toEqual([]);
    }
    const visual = creative("GS25 camping supplies", "2021-05-11", true);
    expect(select(visual, ["camping_scene", "hand_near_food"]).evidence).toHaveLength(5);
  });
  it("excludes same-day sources even when their exact time precedes the current clock", () => {
    expect(select({ ...starbucks, publicationDate: "2026-05-18" }).evidence).toEqual([]);
    expect(select({ ...maple, publicationDate: "2023-11-26" }).evidence).toEqual([]);
    const sameDay = select({ ...maple, publicationDate: "2023-11-30" });
    expect(sameDay.evidence).toHaveLength(1);
    expect(sameDay.evidence[0].assertionKind).toBe("reported_fact");
    expect(select({ ...gs, publicationDate: "2021-05-10" }).evidence).toHaveLength(4);
  });
  it("excludes later, unknown-date and future-availability evidence", () => {
    const records = candidates();
    records.data[2].evidence[0].source.published_on = null;
    records.data[2].evidence[1].observed_at = "2026-11-05T00:00:00Z";
    // Without the source-backed copy trigger, the case cannot be selected.
    expect(select(gs, [], records).evidence).toEqual([]);
    expect(select({ ...maple, publicationDate: "2023-11-27" }).evidence).toHaveLength(1);
  });
  it("preserves the complete eligible rebuttal/correction chain without retrospective summaries", () => {
    const records = candidates(); records.data[1].case.context_summary = "FUTURE-SUMMARY-SENTINEL";
    records.data[1].triggers[0].description = "FUTURE-TRIGGER-SENTINEL";
    const selected = select(maple, [], records);
    expect(selected.evidence).toHaveLength(4);
    const correction = selected.evidence.find((entry) => entry.assertionKind === "correction");
    expect(selected.evidence.some((entry) => entry.evidenceId === correction.relatedEvidenceId)).toBe(true);
    expect(selected.evidence.some((entry) => entry.assertionKind === "rebuttal")).toBe(true);
    expect(correction.provenance).toContain("SECONDARY");
    expect(JSON.stringify(selected)).not.toContain("SENTINEL");
    expect(selected.evidence.every((entry) => entry.caseStatus === "emerging")).toBe(true);
  });
  it("omits article excerpts and unapproved sources and distinguishes empty from unavailable", () => {
    const records = candidates();
    records.data[0].evidence[0].source_excerpt = "RESTRICTED-EXCERPT-SENTINEL";
    expect(JSON.stringify(select(starbucks, [], records))).not.toContain("SENTINEL");
    for (const row of records.data[0].evidence) row.source.canonical_url = "https://example.com/unapproved";
    expect(select(starbucks, [], records).evidence).toEqual([]);
    expect(select(starbucks, [], { state: "available", data: [] })).toEqual(empty);
    expect(select(starbucks, [], { state: "unavailable", code: "database_unavailable" })).toEqual({ state: "unavailable", code: "database_unavailable" });
  });
  it("ignores malformed, unsupported and copy-only image observations", () => {
    const text = '<creative_observations>["thumb_index_near"]</creative_observations>';
    expect(observedFeatures([text], true)).toEqual(["thumb_index_near"]);
    expect(observedFeatures([text], false)).toEqual([]);
    for (const value of [text + text, "malformed", '<creative_observations>["political_intent"]</creative_observations>']) expect(observedFeatures([value], true)).toEqual([]);
  });
  it("uses a bounded parameterized repository query and rejects oversized graphs", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const repository = createKnowledgeRepository(async (operation) => ({ state: "available", data: await operation({ query }) }));
    expect(await repository.getReviewCases(REVIEW_CASE_KEYS)).toEqual({ state: "available", data: [] });
    expect(query.mock.calls[0][1]).toEqual([REVIEW_CASE_KEYS, "KR", "emerging", "verified"]);
    expect(query.mock.calls[0][0]).toContain("ANY($1::text[])");
    expect(query.mock.calls[0][0]).toContain("LIMIT 21");
    expect(query.mock.calls[0][0]).toContain("LIMIT 13");
    expect(() => repository.getReviewCases([...REVIEW_CASE_KEYS, "extra"])).toThrow();
    const record = candidates().data[0];
    query.mockResolvedValueOnce({ rows: [{ record: record.case, evidence: Array(21).fill(record.evidence[0]), triggers: [] }] });
    await expect(repository.getReviewCases(REVIEW_CASE_KEYS)).rejects.toThrow();
  });
});

describe("registry-aware two-stage assessment", () => {
  it("passes distinct registry references only to assessment and keeps Meta annotations intact", async () => {
    const selected = select(maple);
    const value = assessment(); value.findings[0].sourceIds = ["S1", "R1", "R3"];
    const fetcher = fetchSequence(researchResponse(), assessmentResponse(value));
    const response = await reviewWithMeta(maple, { apiKey: "test", fetcher, registryRetriever: async () => selected });
    expect(response.state).toBe("completed");
    expect(fetcher).toHaveBeenCalledTimes(2);
    const first = JSON.parse(fetcher.mock.calls[0][1].body), second = JSON.parse(fetcher.mock.calls[1][1].body);
    expect(first.input[0].content[0].text).not.toContain("registry");
    expect(JSON.parse(second.input[0].content[0].text).registry).toEqual(selected);
    expect(response.result.sources[0].id).toBe("S1");
    expect(response.result.registry.evidence[0].id).toBe("R1");
    expect(response.result.registry.evidence[0]).not.toHaveProperty("annotation");
    expect(response.result.registry.evidence[0]).not.toHaveProperty("responseId");
    expect(response.result.verifiedCaseIds).toEqual([]);
    expect(response.result.outcome).toBe("emerging_signal");
  });
  it("forwards only neutral observations from the existing first request with no additional call", async () => {
    const raw = researchResponse(); raw.output.find((item) => item.type === "message").content[0].text += '\n<creative_observations>["thumb_index_near","animated_character"]</creative_observations>';
    const retriever = vi.fn().mockResolvedValue(select(maple));
    const fetcher = fetchSequence(raw, assessmentResponse());
    const value = { ...maple, image: { mediaType: "image/png", dataUrl: "data:image/png;base64,dGVzdA==" } };
    await reviewWithMeta(value, { apiKey: "test", fetcher, registryRetriever: retriever });
    expect(retriever.mock.calls[0][1]).toEqual(["thumb_index_near", "animated_character"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
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
  it("can retain a supported emerging signal with an explicit registry coverage gap", async () => {
    const response = await reviewWithMeta(input, { apiKey: "test", fetcher: fetchSequence(researchResponse(), assessmentResponse()), registryRetriever: async () => ({ state: "unavailable", code: "not_configured" }) });
    expect(response.state).toBe("completed");
    expect(response.result.registry.state).toBe("unavailable");
    expect(response.result.limitations.some((value) => value.includes("coverage gap"))).toBe(true);
  });
  it("rejects invented registry IDs and false verified promotion in model output and contract", async () => {
    const selected = select(maple), value = assessment(); value.findings[0].sourceIds = ["R999"];
    const response = await reviewWithMeta(maple, { apiKey: "test", fetcher: fetchSequence(researchResponse(), assessmentResponse(value)), registryRetriever: async () => selected });
    expect(response).toMatchObject({ state: "failed", issue: { code: "invalid_response" } });
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
