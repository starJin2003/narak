import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildManifest, runIntake, stableId } from "../scripts/lib/three-case-intake.mjs";
import { runDiscoveryIntake } from "../scripts/lib/discovery-review.mjs";
import { ReviewRefused, runCaseReview } from "../scripts/lib/case-review.mjs";
import { createKnowledgeRepository } from "@/server/knowledge/repository";
import { createRegistryRetriever } from "@/server/knowledge/review-context";
import { reviewWithMeta } from "@/server/meta";
import { resultSchema } from "@/lib/review-contract";
import { assessment, assessmentResponse, researchResponse } from "./fixtures";

// A synthetic fourth case, as discovery intake would add it. Not a real page or event.
const FOURTH = "synthetic-lantern-poster-2025-09";
const fourthId = stableId(FOURTH);
const url = "https://news.example.org/synthetic-lantern-poster";
const evidenceId = (key) => stableId(`${FOURTH}/evidence/${key}`);
function fourthRows() {
  return {
    knowledge_sources: [{ id: stableId(url), canonical_url: url, title: "Synthetic report on a lantern parade poster", publisher: "Synthetic News", language_code: "en",
      published_on: "2025-09-01", discovered_at: "2026-11-04T00:00:00Z", discovery_method: "manual", discovered_by: "registry-lifecycle-test",
      provenance_note: "Synthetic test source. Not a real page.", provider_response_id: null, storage_rights: "metadata_only", rights_basis: null, rights_reviewed_by: null, rights_reviewed_at: null }],
    knowledge_cases: [{ id: fourthId, case_key: FOURTH, title: "Synthetic lantern parade poster, September 2025", context_summary: "SUMMARY-SENTINEL written after later events.",
      status: "emerging", market: "KR", event_start_date: "2025-09-01", event_end_date: null, first_seen_at: "2026-11-04T00:00:00Z", last_seen_at: "2026-11-04T00:00:00Z",
      reviewed_at: null, reviewed_by: null, review_method: null, review_rationale: null }],
    case_evidence: [
      { id: evidenceId("fact"), case_id: fourthId, evidence_key: "fact", source_id: stableId(url), assertion_kind: "reported_fact",
        assertion_text: "Synthetic News reports public complaints about a lantern parade poster's slogan.", attribution: "Readers, as reported by Synthetic News",
        model_id: null, source_locator: "Synthetic page", source_excerpt: null, related_evidence_id: null, observed_at: "2025-09-01T00:00:00+09:00" },
      { id: evidenceId("rebuttal"), case_id: fourthId, evidence_key: "rebuttal", source_id: stableId(url), assertion_kind: "rebuttal",
        assertion_text: "Synthetic News reports the organizer said the slogan was ordinary festival wording.", attribution: "The organizer, as reported by Synthetic News",
        model_id: null, source_locator: "Synthetic page", source_excerpt: null, related_evidence_id: null, observed_at: "2025-09-01T00:00:00+09:00" },
    ],
    case_triggers: [
      { id: stableId(`${FOURTH}/trigger/copy`), case_id: fourthId, trigger_key: "copy", evidence_id: evidenceId("fact"), trigger_kind: "copy",
        description: "Synthetic slogan. Relevance hypothesis written by a reviewer, not a finding.", match_text: "Lantern Night Parade",
        publication_start_date: null, publication_end_date: null, valid_from: "2025-09-01", valid_until: null, inference_origin: "human_review", model_id: null },
      { id: stableId(`${FOURTH}/trigger/imagery`), case_id: fourthId, trigger_key: "imagery", evidence_id: evidenceId("fact"), trigger_kind: "imagery",
        description: "Synthetic imagery. Relevance hypothesis written by a reviewer, not a finding.", match_text: "paper lantern tied with a red ribbon",
        publication_start_date: null, publication_end_date: null, valid_from: "2025-09-01", valid_until: null, inference_origin: "human_review", model_id: null },
    ],
  };
}

const localUrl = process.env.NARAK_TEST_DATABASE_URL;
const image = { mediaType: "image/png", dataUrl: "data:image/png;base64,dGVzdA==" };
const creative = (copy, publicationDate = "2026-12-01", withImage = false) => ({ copy, publicationDate, market: "KR", ...(withImage ? { image } : {}) });
const fetchSequence = (...responses) => { const fetcher = vi.fn(); for (const response of responses) fetcher.mockResolvedValueOnce(Response.json(response)); return fetcher; };
const withVisibleText = (lines) => { const raw = researchResponse(); raw.output.find((item) => item.type === "message").content[0].text += `\n<visible_text>${JSON.stringify(lines)}</visible_text>`; return raw; };
const cite = (sourceIds, phrase = "Lantern Night Parade") => { const value = assessment(true, phrase); value.findings[0].sourceIds = sourceIds; value.findings[0].reactionSourceIds = ["S1"]; return value; };

describe.skipIf(!localUrl)("registry lifecycle against a disposable local PostgreSQL registry", () => {
  let client, repository, retriever;
  beforeAll(async () => {
    if (new URL(localUrl).hostname !== "127.0.0.1") throw new Error("Disposable loopback database required");
    client = new pg.Client({ connectionString: localUrl }); await client.connect();
    await client.query(readFileSync("db/migrations/001_knowledge_registry.sql", "utf8"));
    await runIntake(client, { apply: true });
    await runDiscoveryIntake(client, fourthRows(), { apply: true });
    repository = createKnowledgeRepository(async (operation) => {
      await client.query("BEGIN READ ONLY");
      try { const data = await operation(client); await client.query("COMMIT"); return { state: "available", data }; }
      catch (error) { await client.query("ROLLBACK"); throw error; }
    });
    retriever = createRegistryRetriever(() => repository.getReviewCandidates());
  });
  afterAll(async () => { if (client) await client.end(); });
  beforeEach(() => vi.spyOn(console, "info").mockImplementation(() => undefined));
  const count = async (sql, values = []) => (await client.query(sql, values)).rows[0].count;

  it("reads all four cases with a bounded read-only query and no fixed case keys", async () => {
    const read = await repository.getReviewCandidates();
    expect(read.state).toBe("available");
    expect(read.data.truncated).toBe(false);
    expect(read.data.cases.map((item) => item.case.case_key).sort()).toEqual([...buildManifest().knowledge_cases.map((row) => row.case_key), FOURTH].sort());
    expect(read.data.cases.every((item) => item.complete)).toBe(true);
  });

  it("selects the fourth intaken case by its copy trigger and sends its notes to the assessment", async () => {
    const fetcher = fetchSequence(researchResponse(), assessmentResponse(cite(["S1", "R1"])));
    const response = await reviewWithMeta(creative("Lantern Night Parade tickets"), { apiKey: "test", fetcher, registryRetriever: retriever });
    expect(response.state).toBe("completed");
    const sent = JSON.parse(JSON.parse(fetcher.mock.calls[1][1].body).input[0].content[0].text);
    expect(sent.registry.matchedCaseIds).toEqual([fourthId]);
    expect(sent.registry.evidence.map((note) => note.assertionKind)).toEqual(["reported_fact", "rebuttal"]);
    expect(JSON.stringify(sent)).not.toContain("SUMMARY-SENTINEL");
    expect(response.result.registry.matchedCaseIds).toEqual([fourthId]);
    expect(response.result.outcome).toBe("emerging_signal");
    expect(response.result.verifiedCaseIds).toEqual([]);
  });

  it("selects the fourth case from the poster's words or from one imagery check, with no copy", async () => {
    const imageryReply = (visibleCaseIds) => ({ id: "r", status: "completed", output: [{ type: "message", id: "m", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: JSON.stringify({ visibleCaseIds }), annotations: [] }] }] });
    // The words select the fourth case; the other cases' imagery cues still get their one check.
    const byText = fetchSequence(withVisibleText(["LANTERN", "NIGHT PARADE"]), imageryReply([]), assessmentResponse(assessment(false)));
    const text = await reviewWithMeta(creative("", "2026-12-01", true), { apiKey: "test", fetcher: byText, registryRetriever: retriever });
    expect(text.result.registry.matchedCaseIds).toEqual([fourthId]);
    expect(JSON.parse(byText.mock.calls[1][1].body).text.format.schema.properties.visibleCaseIds.items.enum).not.toContain(fourthId);
    // With no matching words, the seed and synthetic imagery cues go to one check.
    const imagery = imageryReply([fourthId]);
    const byImage = fetchSequence(withVisibleText([]), imagery, assessmentResponse(assessment(false)));
    const pictured = await reviewWithMeta(creative("", "2026-12-01", true), { apiKey: "test", fetcher: byImage, registryRetriever: retriever });
    const check = JSON.parse(byImage.mock.calls[1][1].body);
    expect(check.text.format.schema.properties.visibleCaseIds.items.enum).toContain(fourthId);
    expect(JSON.stringify(check)).not.toContain("SUMMARY-SENTINEL");
    expect(pictured.result.registry.matchedCaseIds).toEqual([fourthId]);
  });

  it("dry runs print the case graph, flag model-written triggers and write nothing", async () => {
    const key = buildManifest().knowledge_cases[2].case_key;
    const before = await count("SELECT count(*)::int AS count FROM narak.case_status_events");
    const dry = await runCaseReview(client, { caseRef: key });
    expect(dry.result).toBe("dry_run");
    expect(dry.report.sources.length).toBeGreaterThan(0);
    expect(dry.report.evidence.length).toBeGreaterThan(0);
    expect(dry.report.triggers).toHaveLength(3);
    expect(dry.report.flags.filter((flag) => flag.includes("written by model"))).toHaveLength(3);
    const planned = await runCaseReview(client, { caseRef: key, decision: "verify", reviewer: "Synthetic Reviewer", rationale: "Synthetic rationale for a dry run only." });
    expect(planned).toMatchObject({ result: "dry_run", decision: { toStatus: "verified", reviewer: "Synthetic Reviewer" } });
    expect(await count("SELECT count(*)::int AS count FROM narak.case_status_events")).toBe(before);
    expect(await count("SELECT count(*)::int AS count FROM narak.knowledge_cases WHERE status <> 'emerging'")).toBe(0);
  });

  it("refuses incomplete decisions and unreviewed model triggers before anything is written", async () => {
    const key = buildManifest().knowledge_cases[2].case_key;
    for (const input of [{ caseRef: key, decision: "verify", reviewer: "", rationale: "A rationale that is long enough." },
      { caseRef: key, decision: "verify", reviewer: "Synthetic Reviewer", rationale: "short" }, { caseRef: key, decision: "approve", reviewer: "Synthetic Reviewer", rationale: "A rationale that is long enough." }]) {
      await expect(runCaseReview(client, input, { apply: true })).rejects.toThrow(ReviewRefused);
    }
    await expect(runCaseReview(client, { caseRef: key, decision: "verify", reviewer: "Synthetic Reviewer", rationale: "A rationale that is long enough." }, { apply: true }))
      .rejects.toThrow("written by a model");
    await expect(runCaseReview(client, { caseRef: "no-such-case" })).rejects.toThrow("No case matches");
    expect(await count("SELECT count(*)::int AS count FROM narak.knowledge_cases WHERE status <> 'emerging'")).toBe(0);
  });

  it("verifies one case with a named reviewer and an audit event, and locks its material", async () => {
    const applied = await runCaseReview(client, { caseRef: FOURTH, decision: "verify", reviewer: "Synthetic Reviewer", rationale: "Synthetic verification for the lifecycle test." }, { apply: true });
    expect(applied.result).toBe("applied");
    const row = (await client.query("SELECT status, reviewed_by, review_method FROM narak.knowledge_cases WHERE id = $1", [fourthId])).rows[0];
    expect(row).toEqual({ status: "verified", reviewed_by: "Synthetic Reviewer", review_method: "human_review" });
    const event = (await client.query("SELECT from_status, to_status, actor, review_method, rationale FROM narak.case_status_events WHERE case_id = $1 ORDER BY id DESC LIMIT 1", [fourthId])).rows[0];
    expect(event).toEqual({ from_status: "emerging", to_status: "verified", actor: "Synthetic Reviewer", review_method: "human_review", rationale: "Synthetic verification for the lifecycle test." });
    await client.query("BEGIN");
    try { await expect(client.query("UPDATE narak.case_evidence SET assertion_text = 'changed' WHERE case_id = $1", [fourthId])).rejects.toMatchObject({ code: "23514" }); }
    finally { await client.query("ROLLBACK"); }
    await expect(runCaseReview(client, { caseRef: FOURTH, decision: "reject", reviewer: "Synthetic Reviewer", rationale: "A second decision must be refused." }, { apply: true }))
      .rejects.toThrow("Only an emerging case");
  });

  it("derives an evidence-backed concern from a verified reported fact, and only then", async () => {
    const run = (value, date = "2026-12-01") => reviewWithMeta(creative("Lantern Night Parade tickets", date), { apiKey: "test", fetcher: fetchSequence(researchResponse(), assessmentResponse(value)), registryRetriever: retriever });
    const backed = await run(cite(["S1", "R1"]));
    expect(backed.result.registry.evidence[0]).toMatchObject({ id: "R1", caseStatus: "verified", assertionKind: "reported_fact" });
    expect(backed.result.outcome).toBe("evidence_backed_concern");
    expect(backed.result.verifiedCaseIds).toEqual([fourthId]);
    expect(resultSchema.safeParse(backed.result).success).toBe(true);
    expect(resultSchema.safeParse({ ...backed.result, verifiedCaseIds: [] }).success).toBe(false);
    const rebuttal = await run(cite(["S1", "R2"]));
    expect(rebuttal.result.outcome).toBe("emerging_signal");
    // Before the source was published, the verified case is not eligible at all.
    const early = await run(cite(["S1"]), "2025-08-31");
    expect(early.result.registry.matchedCaseIds).toEqual([]);
    expect(early.result.outcome).toBe("emerging_signal");
  });

  it("rejects a case, which then stops being a review candidate", async () => {
    const key = buildManifest().knowledge_cases[0].case_key;
    expect((await runCaseReview(client, { caseRef: key, decision: "reject", reviewer: "Synthetic Reviewer", rationale: "Synthetic rejection for the lifecycle test." }, { apply: true })).result).toBe("applied");
    const read = await repository.getReviewCandidates();
    expect(read.data.cases.map((item) => item.case.case_key)).not.toContain(key);
    expect(read.data.cases.find((item) => item.case.id === fourthId).case.status).toBe("verified");
  });

  it("the command line dry run reads through the reader connection, and apply never runs without the privileged configuration", () => {
    const env = { ...process.env, DATABASE_URL: localUrl, DATABASE_MIGRATION_URL: "", NODE_ENV: "test" };
    const key = buildManifest().knowledge_cases[1].case_key;
    const dry = spawnSync(process.execPath, ["scripts/review-case.mjs", "--case", key], { env, encoding: "utf8" });
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain(`Case ${key}`);
    expect(dry.stdout).toContain("Flags for the reviewer");
    expect(dry.stdout).toContain("Dry run, nothing written");
    const apply = spawnSync(process.execPath, ["scripts/review-case.mjs", "--case", key, "--decision", "reject", "--reviewer", "Synthetic Reviewer", "--rationale", "Must not be written by this test.", "--apply"], { env, encoding: "utf8" });
    expect(apply.status).toBe(1);
    expect(apply.stderr).toContain("Nothing was written");
    expect(spawnSync(process.execPath, ["scripts/review-case.mjs", "--case", key, "--session-pooler"], { env, encoding: "utf8" }).status).toBe(2);
  });

  it("the CLI wrote nothing in the previous test", async () => {
    const key = buildManifest().knowledge_cases[1].case_key;
    expect((await client.query("SELECT status FROM narak.knowledge_cases WHERE case_key = $1", [key])).rows[0].status).toBe("emerging");
  });
});
