import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { createKnowledgeRepository } from "@/server/knowledge/repository";
import { withKnowledgeRead } from "@/server/knowledge/database";

const testUrl = process.env.NARAK_TEST_DATABASE_URL;
const suite = testUrl ? describe : describe.skip;

suite("PostgreSQL knowledge registry", () => {
  let pool: Pool;
  let client: PoolClient;
  let verifiedId: string;
  let emergingId: string;
  let rejectedId: string;
  const repository = createKnowledgeRepository();

  async function createCase(connection: PoolClient, key = "test-" + randomUUID()) {
    const result = await connection.query(`INSERT INTO narak.knowledge_cases
      (case_key, title, context_summary, first_seen_at, last_seen_at)
      VALUES ($1, 'Synthetic case', 'Synthetic context, not a real event.', '2026-01-01Z', '2026-01-02Z') RETURNING id`, [key]);
    return result.rows[0].id as string;
  }
  async function createSource(connection: PoolClient) {
    const result = await connection.query(`INSERT INTO narak.knowledge_sources
      (canonical_url, title, language_code, discovered_at, discovery_method, discovered_by, provenance_note)
      VALUES ($1, 'Synthetic source', 'ko', '2026-01-01Z', 'manual', 'Test reviewer', 'Synthetic local fixture, not a retrieved article.') RETURNING id`, ["https://example.com/" + randomUUID()]);
    return result.rows[0].id as string;
  }
  async function addEvidence(connection: PoolClient, caseId: string, sourceId: string, kind = "reported_fact") {
    const result = await connection.query(`INSERT INTO narak.case_evidence
      (case_id, evidence_key, source_id, assertion_kind, assertion_text, attribution, observed_at, model_id)
      VALUES ($1, $2, $3, $4, 'Synthetic paraphrase.', 'Synthetic source author', '2026-01-01Z', $5) RETURNING id`,
    [caseId, "evidence-" + randomUUID(), sourceId, kind, kind === "model_inference" ? "test-model" : null]);
    return result.rows[0].id as string;
  }
  async function transition(connection: PoolClient, id: string, status: string) {
    return connection.query(`UPDATE narak.knowledge_cases SET status = $2, reviewed_by = 'Test human reviewer',
      reviewed_at = clock_timestamp(), review_method = 'human_review', review_rationale = 'Explicit synthetic review decision.' WHERE id = $1`, [id, status]);
  }

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (url.hostname !== "127.0.0.1" || process.env.DATABASE_URL !== testUrl) throw new Error("Disposable loopback test cluster required");
    pool = new Pool({ connectionString: testUrl, max: 2, ssl: false });
    await pool.query(readFileSync("db/migrations/001_knowledge_registry.sql", "utf8"));
    const setup = await pool.connect();
    try {
      verifiedId = await createCase(setup, "verified-fixture");
      emergingId = await createCase(setup, "emerging-fixture");
      rejectedId = await createCase(setup, "rejected-fixture");
      const source = await createSource(setup);
      const evidence = await addEvidence(setup, verifiedId, source);
      await setup.query(`INSERT INTO narak.case_triggers (case_id, trigger_key, evidence_id, trigger_kind, description, match_text, inference_origin)
        VALUES ($1, 'copy-context', $2, 'copy', 'Synthetic contextual relevance.', 'synthetic', 'human_review')`, [verifiedId, evidence]);
      await transition(setup, verifiedId, "verified");
      await transition(setup, rejectedId, "rejected");
    } finally { setup.release(); }
  });
  beforeEach(async () => { client = await pool.connect(); await client.query("BEGIN"); });
  afterEach(async () => { if (client) { await client.query("ROLLBACK"); client.release(); } });
  afterAll(async () => { await pool?.end(); });

  it("creates exactly five tables in a private schema without public usage", async () => {
    const result = await client.query("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'narak'");
    expect(result.rows[0].count).toBe(5);
    const grants = await client.query("SELECT nspacl::text AS acl FROM pg_namespace WHERE nspname = 'narak'");
    expect(grants.rows[0].acl).not.toMatch(/[,\{]=U/);
  });
  it("new evidence does not automatically promote a case", async () => {
    const id = await createCase(client);
    await addEvidence(client, id, await createSource(client));
    expect((await client.query("SELECT status FROM narak.knowledge_cases WHERE id = $1", [id])).rows[0].status).toBe("emerging");
  });
  it("rejects direct creation as verified even with metadata", async () => {
    await expect(client.query(`INSERT INTO narak.knowledge_cases (case_key, title, context_summary, status, first_seen_at, last_seen_at, reviewed_at, reviewed_by, review_method, review_rationale)
      VALUES ('direct-verified', 'Test', 'Test', 'verified', now(), now(), now(), 'Reviewer', 'human_review', 'Test')`)).rejects.toMatchObject({ code: "23514" });
  });
  it("requires explicit review metadata on promotion", async () => {
    const id = await createCase(client);
    await addEvidence(client, id, await createSource(client));
    await expect(client.query("UPDATE narak.knowledge_cases SET status = 'verified' WHERE id = $1", [id])).rejects.toMatchObject({ code: "23514" });
  });
  it("requires source-linked reported facts, not inference alone, for verification", async () => {
    const id = await createCase(client);
    await addEvidence(client, id, await createSource(client), "model_inference");
    await expect(transition(client, id, "verified")).rejects.toMatchObject({ code: "23514" });
  });
  it("requires a fresh review for each subsequent status transition", async () => {
    const id = await createCase(client);
    await transition(client, id, "rejected");
    await expect(client.query("UPDATE narak.knowledge_cases SET status = 'archived' WHERE id = $1", [id])).rejects.toMatchObject({ code: "23514" });
  });
  it("records reviewed transitions and preserves rejected and archived states", async () => {
    const id = await createCase(client);
    await transition(client, id, "rejected");
    await transition(client, id, "archived");
    const result = await client.query("SELECT from_status, to_status, actor, rationale FROM narak.case_status_events WHERE case_id = $1 ORDER BY id", [id]);
    expect(result.rows.map(row => [row.from_status, row.to_status])).toEqual([[null, "emerging"], ["emerging", "rejected"], ["rejected", "archived"]]);
    expect(result.rows[1].actor).toBe("Test human reviewer");
    expect(result.rows[1].rationale).toBe("Explicit synthetic review decision.");
  });
  it.each(["UPDATE narak.case_status_events SET rationale = 'forged'", "DELETE FROM narak.case_status_events", "TRUNCATE narak.case_status_events"])("protects audit records from %s", async (sql) => {
    await expect(client.query(sql)).rejects.toMatchObject({ code: "23514" });
  });
  it("rejects forged audit insertions", async () => {
    await expect(client.query(`INSERT INTO narak.case_status_events (case_id, to_status, actor, review_method, rationale)
      VALUES ($1, 'emerging', 'forged', 'registration', 'forged')`, [emergingId])).rejects.toMatchObject({ code: "23514" });
  });
  it("prevents duplicate case identities", async () => {
    await expect(createCase(client, "verified-fixture")).rejects.toMatchObject({ code: "23505" });
  });
  it("prevents duplicate canonical source URLs", async () => {
    const source = await createSource(client);
    await expect(client.query(`INSERT INTO narak.knowledge_sources
      (canonical_url, title, language_code, discovered_at, discovery_method, discovered_by, provenance_note)
      SELECT canonical_url, title, language_code, discovered_at, discovery_method, discovered_by, provenance_note FROM narak.knowledge_sources WHERE id = $1`, [source])).rejects.toMatchObject({ code: "23505" });
  });
  it.each([
    "last_seen_at = '2025-01-01Z'",
    "event_start_date = '2026-02-01', event_end_date = '2026-01-01'",
    "market = 'US'",
  ])("rejects invalid temporal context or market: %s", async (assignment) => {
    const id = await createCase(client);
    // Fixed test statements, never runtime/user-provided SQL.
    await expect(client.query("UPDATE narak.knowledge_cases SET " + assignment + " WHERE id = $1", [id])).rejects.toMatchObject({ code: "23514" });
  });
  it("requires an existing actual source for every assertion", async () => {
    await expect(addEvidence(client, emergingId, randomUUID())).rejects.toMatchObject({ code: "23503" });
  });
  it("does not allow a trigger to reference evidence from a different case", async () => {
    const evidence = await addEvidence(client, emergingId, await createSource(client));
    await expect(client.query(`INSERT INTO narak.case_triggers (case_id, trigger_key, evidence_id, trigger_kind, description, match_text, inference_origin)
      VALUES ($1, 'wrong-case', $2, 'imagery', 'Test', 'Test', 'human_review')`, [rejectedId, evidence])).rejects.toMatchObject({ code: "23503" });
  });
  it("requires corrections to identify the related assertion", async () => {
    await expect(addEvidence(client, emergingId, await createSource(client), "correction")).rejects.toMatchObject({ code: "23514" });
  });
  it("links a correction only to evidence within its own case", async () => {
    const source = await createSource(client);
    const prior = await addEvidence(client, emergingId, source);
    await expect(client.query(`INSERT INTO narak.case_evidence
      (case_id, evidence_key, source_id, assertion_kind, assertion_text, attribution, observed_at, related_evidence_id)
      VALUES ($1, 'cross-case-correction', $2, 'correction', 'Correction', 'Test author', now(), $3)`, [rejectedId, source, prior])).rejects.toMatchObject({ code: "23503" });
  });
  it("stores Korean source data losslessly and labels model inference separately", async () => {
    const source = await createSource(client);
    const text = "\uBCF4\uB3C4\uB41C \uBB38\uD654\uC801 \uB9E5\uB77D";
    const evidence = await addEvidence(client, emergingId, source, "model_inference");
    await client.query("UPDATE narak.case_evidence SET assertion_text = $2 WHERE id = $1", [evidence, text]);
    const result = await client.query("SELECT assertion_text, assertion_kind, model_id FROM narak.case_evidence WHERE id = $1", [evidence]);
    expect(result.rows[0]).toEqual({ assertion_text: text, assertion_kind: "model_inference", model_id: "test-model" });
  });
  it("defaults to metadata-only rights and rejects unapproved excerpts", async () => {
    const source = await createSource(client);
    const evidence = await addEvidence(client, emergingId, source);
    expect((await client.query("SELECT storage_rights FROM narak.knowledge_sources WHERE id = $1", [source])).rows[0].storage_rights).toBe("metadata_only");
    await expect(client.query("UPDATE narak.case_evidence SET source_excerpt = 'Copied passage' WHERE id = $1", [evidence])).rejects.toMatchObject({ code: "23514" });
  });
  it("requires rights review metadata before permitting excerpts", async () => {
    const source = await createSource(client);
    await expect(client.query("UPDATE narak.knowledge_sources SET storage_rights = 'excerpt_permitted' WHERE id = $1", [source])).rejects.toMatchObject({ code: "23514" });
  });
  it("permits bounded excerpts only after rights approval", async () => {
    const source = await createSource(client);
    await client.query(`UPDATE narak.knowledge_sources SET storage_rights = 'excerpt_permitted', rights_basis = 'Original synthetic test text.',
      rights_reviewed_by = 'Test rights reviewer', rights_reviewed_at = now() WHERE id = $1`, [source]);
    const evidence = await addEvidence(client, emergingId, source);
    await client.query("UPDATE narak.case_evidence SET source_excerpt = 'Original synthetic excerpt.' WHERE id = $1", [evidence]);
    await expect(client.query("UPDATE narak.case_evidence SET source_excerpt = $2 WHERE id = $1", [evidence, "x".repeat(1001)])).rejects.toMatchObject({ code: "23514" });
  });
  it("protects verified material until explicit reopening", async () => {
    await expect(client.query("UPDATE narak.case_evidence SET assertion_text = 'Unreviewed edit' WHERE case_id = $1", [verifiedId])).rejects.toMatchObject({ code: "23514" });
  });
  it("protects the source of verified assertions", async () => {
    await expect(client.query("UPDATE narak.knowledge_sources SET title = 'Unreviewed edit' WHERE id IN (SELECT source_id FROM narak.case_evidence WHERE case_id = $1)", [verifiedId])).rejects.toMatchObject({ code: "23514" });
  });
  it("preserves source relationships on deletion", async () => {
    const source = await createSource(client);
    await addEvidence(client, emergingId, source);
    await expect(client.query("DELETE FROM narak.knowledge_sources WHERE id = $1", [source])).rejects.toMatchObject({ code: expect.stringMatching(/^(23503|23001)$/) });
  });
  it("reads verified/emerging cases and their source-linked graph", async () => {
    const verified = await repository.listVerifiedCases();
    expect(verified.state).toBe("available");
    if (verified.state !== "available") throw new Error("Registry unavailable");
    expect(verified.data.map(item => item.id)).toEqual([verifiedId]);
    const emerging = await repository.listEmergingCases();
    expect(emerging.state === "available" && emerging.data.map(item => item.id)).toEqual([emergingId]);
    const detail = await repository.getCaseById(verifiedId);
    expect(detail.state).toBe("available");
    if (detail.state !== "available" || !detail.data) throw new Error("Missing case graph");
    expect(detail.data.evidence[0]?.source.id).toBe(detail.data.evidence[0]?.source_id);
    expect(detail.data.triggers[0]?.evidence_id).toBe(detail.data.evidence[0]?.id);
    expect(await repository.getCaseById(rejectedId)).toEqual({ state: "available", data: null });
    expect(await repository.getCaseById(randomUUID())).toEqual({ state: "available", data: null });
  });
  it("enforces read-only transactions and returns unavailable after a failed read", async () => {
    const state = await withKnowledgeRead(async connection => (await connection.query("SHOW transaction_read_only")).rows);
    expect(state).toEqual({ state: "available", data: [{ transaction_read_only: "on" }] });
    expect(await withKnowledgeRead(async connection => connection.query("DELETE FROM narak.knowledge_cases"))).toEqual({ state: "unavailable", code: "database_unavailable" });
    expect(await withKnowledgeRead(async connection => connection.query("SELECT * FROM narak.missing_table"))).toEqual({ state: "unavailable", code: "database_unavailable" });
    expect((await repository.listVerifiedCases()).state).toBe("available");
  });
});
