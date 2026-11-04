import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  IntakeConflict, ReviewRefused, buildDiscoveryManifest, createWorksheet, recordDecision, reviewStatus, runDiscoveryIntake, setCase,
} from "../scripts/lib/discovery-review.mjs";
import { createKnowledgeRepository } from "../src/server/knowledge/repository";
import { createRegistryRetriever } from "../src/server/knowledge/review-context";

// A synthetic staged discovery file. No live provider output or real publisher data.
const staged = {
  schema: "narak.discovery.v1", createdAt: "2026-11-04T10:00:00.000Z",
  topic: { query: "synthetic poster dispute", before: "2026-11-20", caseKey: null },
  model: "muse-spark-1.3", researchResponseId: "resp_synthetic", extractionResponseId: "resp_synthetic_x",
  completedSearches: 3, citedSources: 3, registryChecked: true, reviewState: "emerging", humanReviewed: false,
  candidates: [
    { canonicalUrl: "https://news.example.com/poster-a", title: "Synthetic report A", publisher: "Example News", languageCode: "en", publishedOn: "2021-05-03",
      discoveryMethod: "meta_web_search", discoveredBy: "narak-discovery-cli", providerResponseId: "resp_synthetic", storageRights: "metadata_only", robots: "allowed",
      citedResearch: { label: "Model research text", passages: ["Synthetic passage"] }, reviewState: "emerging", humanReviewed: false,
      assertions: [
        { kind: "reported_fact", text: "A synthetic retailer withdrew a camping poster.", attribution: "Example News", modelId: "muse-spark-1.3" },
        { kind: "reported_interpretation", text: "Some viewers read a hand shape as a symbol.", attribution: "Some viewers", modelId: "muse-spark-1.3" },
        { kind: "correction", text: "The outlet later corrected the date of the withdrawal.", attribution: "Example News", modelId: "muse-spark-1.3" },
      ] },
    { canonicalUrl: "https://other.example.org/poster-b", title: "Synthetic report B", publisher: "Other Daily", languageCode: "ko", publishedOn: "2021-05-04",
      discoveryMethod: "meta_web_search", discoveredBy: "narak-discovery-cli", providerResponseId: "resp_synthetic", storageRights: "metadata_only", robots: "allowed",
      citedResearch: { label: "Model research text", passages: ["Synthetic passage"] }, reviewState: "emerging", humanReviewed: false,
      assertions: [{ kind: "rebuttal", text: "The retailer said the image had no hidden meaning.", attribution: "The retailer, as reported by Other Daily", modelId: "muse-spark-1.3" }] },
    { canonicalUrl: "https://blocked.example.net/poster-c", title: "Synthetic report C", publisher: "Blocked Wire", languageCode: "en", publishedOn: "2021-05-05",
      discoveryMethod: "meta_web_search", discoveredBy: "narak-discovery-cli", providerResponseId: "resp_synthetic", storageRights: "metadata_only", robots: "unreachable",
      citedResearch: { label: "Model research text", passages: ["Synthetic passage"] }, reviewState: "emerging", humanReviewed: false,
      assertions: [{ kind: "reported_fact", text: "A synthetic third report.", attribution: "Blocked Wire", modelId: "muse-spark-1.3" }] },
  ],
  excluded: [], gaps: [],
};
const text = JSON.stringify(staged);
const now = new Date("2026-11-04T12:00:00Z");
const reviewer = "Test Reviewer";
const accept = (overrides = {}) => ({
  candidateId: "D1", decision: "accepted", reviewer, rationale: "Read the synthetic page and confirmed the date and quotes.",
  pageRead: true, attributionChecked: true, publishedOn: "2021-05-03", keep: [1, 2, 3],
  rewrites: { 2: { attribution: "Some viewers, as reported by Example News" }, 3: { corrects: "D1#1" } }, ...overrides,
});
const caseInput = {
  caseKey: "synthetic-poster-2021-05", title: "Synthetic poster dispute", contextSummary: "Synthetic test case for intake only.", eventStartDate: "2021-05-01",
  authoredBy: reviewer, triggers: [{ key: "copy-camping-poster", kind: "copy", matchText: "camping poster", evidence: "D1#1", description: "Synthetic copy trigger." }],
};

function reviewed() {
  let sheet = createWorksheet("synthetic.json", text);
  sheet = recordDecision(sheet, text, accept(), now);
  sheet = recordDecision(sheet, text, { candidateId: "D2", decision: "accepted", reviewer, rationale: "Read the synthetic rebuttal page.", pageRead: true, attributionChecked: true, publishedOn: "2021-05-04", keep: [1] }, now);
  sheet = recordDecision(sheet, text, { candidateId: "D3", decision: "rejected", reviewer, rationale: "The robots check could not be completed." }, now);
  return setCase(sheet, text, caseInput, now);
}

describe("discovery review decisions", () => {
  it("lists every candidate as pending and flags attributions that do not name the publisher", () => {
    const status = reviewStatus(createWorksheet("synthetic.json", text), text);
    expect(status.map((row) => [row.candidateId, row.decision])).toEqual([["D1", "pending"], ["D2", "pending"], ["D3", "pending"]]);
    expect(status[0].attributionNeedsPublisher).toEqual(["D1#2"]);
    expect(status[1].attributionNeedsPublisher).toEqual([]);
  });

  it("refuses an acceptance that skips the page, the attribution or the date checks", () => {
    const sheet = createWorksheet("synthetic.json", text);
    expect(() => recordDecision(sheet, text, accept({ pageRead: false }), now)).toThrow(ReviewRefused);
    expect(() => recordDecision(sheet, text, accept({ attributionChecked: false }), now)).toThrow("checked who makes each assertion");
    expect(() => recordDecision(sheet, text, accept({ publishedOn: undefined }), now)).toThrow("publication date");
    expect(() => recordDecision(sheet, text, accept({ publishedOn: "2026-11-20" }), now)).toThrow("not before the discovery cutoff");
    expect(() => recordDecision(sheet, text, accept({ keep: [] }), now)).toThrow("at least one assertion");
  });

  it("requires a publisher in every kept attribution and a target for every correction", () => {
    const sheet = createWorksheet("synthetic.json", text);
    expect(() => recordDecision(sheet, text, accept({ rewrites: { 3: { corrects: "D1#1" } } }), now)).toThrow('attributed to "Some viewers"');
    expect(() => recordDecision(sheet, text, accept({ rewrites: { 2: { attribution: "Some viewers, as reported by Example News" } } }), now)).toThrow("needs the assertion it corrects");
    expect(() => recordDecision(sheet, text, accept({ rewrites: { ...accept().rewrites, 1: { corrects: "D1#2" } } }), now)).toThrow("Only a correction");
  });

  it("refuses a candidate whose robots check failed and records rejections with a reason", () => {
    const sheet = createWorksheet("synthetic.json", text);
    expect(() => recordDecision(sheet, text, { candidateId: "D3", decision: "accepted", reviewer, rationale: "Looks fine to me today.", pageRead: true, attributionChecked: true, publishedOn: "2021-05-05", keep: [1] }, now)).toThrow("robots");
    expect(() => recordDecision(sheet, text, { candidateId: "D3", decision: "rejected", reviewer, rationale: "" }, now)).toThrow(ReviewRefused);
    const rejected = recordDecision(sheet, text, { candidateId: "D3", decision: "rejected", reviewer, rationale: "The robots check could not be completed." }, now);
    expect(reviewStatus(rejected, text)[2].decision).toBe("rejected");
  });

  it("labels kept model paraphrases and reviewer rewrites, and keeps the full decision history", () => {
    let sheet = recordDecision(createWorksheet("synthetic.json", text), text, accept(), now);
    const [first] = sheet.history;
    expect(first.assertions.map((item) => item.origin)).toEqual(["model_paraphrase_confirmed", "reviewer_rewrite", "model_paraphrase_confirmed"]);
    sheet = recordDecision(sheet, text, { candidateId: "D1", decision: "rejected", reviewer, rationale: "Second look found the page was an opinion column." }, now);
    expect(sheet.history).toHaveLength(2);
    expect(reviewStatus(sheet, text)[0].decision).toBe("rejected");
  });

  it("stops when the staged file changed after its review began", () => {
    const sheet = createWorksheet("synthetic.json", text);
    const edited = JSON.stringify({ ...staged, candidates: staged.candidates.slice(0, 1) });
    expect(() => recordDecision(sheet, edited, accept(), now)).toThrow("changed after its review started");
  });
});

describe("discovery intake manifest", () => {
  it("refuses intake while any candidate is pending, without a case, without facts or without a copy trigger", () => {
    let sheet = recordDecision(createWorksheet("synthetic.json", text), text, accept(), now);
    expect(() => buildDiscoveryManifest(sheet, text, now)).toThrow("Record the case");
    sheet = setCase(sheet, text, caseInput, now);
    expect(() => buildDiscoveryManifest(sheet, text, now)).toThrow("D2, D3 still need one");
    const factless = setCase(recordDecision(recordDecision(recordDecision(createWorksheet("synthetic.json", text), text, accept({ keep: [2], rewrites: { 2: { attribution: "Some viewers, as reported by Example News" } } }), now), text,
      { candidateId: "D2", decision: "rejected", reviewer, rationale: "Not needed for this case." }, now), text, { candidateId: "D3", decision: "rejected", reviewer, rationale: "Robots check failed." }, now), text,
      { ...caseInput, triggers: [{ ...caseInput.triggers[0], evidence: "D1#2" }] }, now);
    expect(() => buildDiscoveryManifest(factless, text, now)).toThrow("at least one reported fact");
    const imageryOnly = setCase(reviewed(), text, { ...caseInput, triggers: [{ ...caseInput.triggers[0], kind: "imagery" }] }, now);
    expect(() => buildDiscoveryManifest(imageryOnly, text, now)).toThrow("copy trigger");
    const dangling = setCase(reviewed(), text, { ...caseInput, triggers: [{ ...caseInput.triggers[0], evidence: "D3#1" }] }, now);
    expect(() => buildDiscoveryManifest(dangling, text, now)).toThrow("not kept");
  });

  it("builds emerging, metadata-only rows with reviewed attribution and as-of dates", () => {
    const rows = buildDiscoveryManifest(reviewed(), text, now);
    expect(rows.knowledge_cases).toEqual([expect.objectContaining({ case_key: "synthetic-poster-2021-05", status: "emerging", reviewed_at: null, reviewed_by: null, review_method: null })]);
    expect(rows.knowledge_sources.map((row) => row.canonical_url)).toEqual(["https://news.example.com/poster-a", "https://other.example.org/poster-b"]);
    expect(rows.knowledge_sources.every((row) => row.storage_rights === "metadata_only" && row.discovery_method === "meta_web_search")).toBe(true);
    expect(rows.knowledge_sources[0].provenance_note).toContain("Test Reviewer read the page on 2026-11-04");
    expect(rows.case_evidence.every((row) => row.source_excerpt === null && row.model_id === null)).toBe(true);
    expect(rows.case_evidence.map((row) => row.assertion_kind)).toEqual(["reported_fact", "reported_interpretation", "rebuttal", "correction"]);
    expect(rows.case_evidence.find((row) => row.assertion_kind === "reported_interpretation").attribution).toBe("Some viewers, as reported by Example News");
    const correction = rows.case_evidence.at(-1);
    expect(correction.related_evidence_id).toBe(rows.case_evidence[0].id);
    expect(rows.case_evidence[0].observed_at).toBe("2021-05-02T15:00:00.000Z");
    expect(rows.case_triggers).toEqual([expect.objectContaining({ trigger_kind: "copy", inference_origin: "human_review", model_id: null, valid_from: "2021-05-03" })]);
  });
});

const localUrl = process.env.NARAK_TEST_DATABASE_URL;
describe.skipIf(!localUrl)("discovery intake against a disposable local PostgreSQL registry", () => {
  let client;
  const rows = () => buildDiscoveryManifest(reviewed(), text, now);
  beforeAll(async () => {
    if (new URL(localUrl).hostname !== "127.0.0.1") throw new Error("Disposable loopback database required");
    client = new pg.Client({ connectionString: localUrl }); await client.connect();
    await client.query(readFileSync("db/migrations/001_knowledge_registry.sql", "utf8"));
  });
  afterAll(async () => { if (client) await client.end(); });
  const count = async (table) => (await client.query(`SELECT count(*)::int AS count FROM narak.${table}`)).rows[0].count;

  it("checks without writing in a read-only transaction", async () => {
    expect(await runDiscoveryIntake(client, rows())).toMatchObject({ result: "ready", status: "emerging", counts: { sources: 2, evidence: 4, triggers: 1 } });
    expect(await count("knowledge_cases")).toBe(0);
  });

  it("inserts one emerging case with its registration event and nothing verified", async () => {
    expect(await runDiscoveryIntake(client, rows(), { apply: true })).toMatchObject({ result: "inserted", caseKey: "synthetic-poster-2021-05" });
    expect(await count("knowledge_sources")).toBe(2);
    expect(await count("case_evidence")).toBe(4);
    const events = (await client.query("SELECT to_status, review_method FROM narak.case_status_events")).rows;
    expect(events).toEqual([{ to_status: "emerging", review_method: "registration" }]);
    expect((await client.query("SELECT count(*)::int AS count FROM narak.knowledge_cases WHERE status = 'verified'")).rows[0].count).toBe(0);
  });

  it("stops on a repeated intake and on a source already in the registry, leaving rows unchanged", async () => {
    const before = (await client.query("SELECT to_jsonb(e) AS row FROM narak.case_evidence e ORDER BY id")).rows;
    await expect(runDiscoveryIntake(client, rows(), { apply: true })).rejects.toThrow(IntakeConflict);
    const renamed = rows();
    renamed.knowledge_cases[0] = { ...renamed.knowledge_cases[0], id: "00000000-0000-4000-8000-0000000000aa", case_key: "synthetic-renamed-case" };
    await expect(runDiscoveryIntake(client, renamed, { apply: true })).rejects.toThrow("already in the registry");
    expect((await client.query("SELECT to_jsonb(e) AS row FROM narak.case_evidence e ORDER BY id")).rows).toEqual(before);
  });

  it("keeps verification behind the database's human review guard", async () => {
    await client.query("BEGIN");
    try { await expect(client.query("UPDATE narak.knowledge_cases SET status = 'verified'")).rejects.toMatchObject({ code: "23514" }); }
    finally { await client.query("ROLLBACK"); }
  });

  it("is readable through the runtime repository, and reviews now select it by its copy trigger", async () => {
    const read = async (operation) => {
      await client.query("BEGIN READ ONLY");
      try { const data = await operation(client); await client.query("COMMIT"); return { state: "available", data }; }
      catch (error) { await client.query("ROLLBACK"); throw error; }
    };
    const repository = createKnowledgeRepository(read);
    const detail = await repository.getCaseById(rows().knowledge_cases[0].id);
    expect(detail.data.case.status).toBe("emerging");
    expect(detail.data.evidence).toHaveLength(4);
    // Selection is data driven, so an intaken case is a candidate as soon as it is in the registry.
    const retriever = createRegistryRetriever(() => repository.getReviewCandidates());
    const context = await retriever({ copy: "A camping poster for the weekend", publicationDate: "2026-11-20", market: "KR" }, [], new AbortController().signal);
    expect(context).toMatchObject({ state: "available", checkedCases: 1, matchedCaseIds: [rows().knowledge_cases[0].id], gaps: [] });
    expect(context.evidence.every((note) => note.caseStatus === "emerging")).toBe(true);
    const unrelated = await retriever({ copy: "A plain winter sale", publicationDate: "2026-11-20", market: "KR" }, [], new AbortController().signal);
    expect(unrelated).toMatchObject({ state: "available", matchedCaseIds: [] });
  });
});
