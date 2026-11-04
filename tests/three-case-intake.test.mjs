import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildManifest, validateManifest, stableId, runIntake, schemaSignature } from "../scripts/lib/three-case-intake.mjs";
import { createKnowledgeRepository } from "../src/server/knowledge/repository";
import { selectRegistryContext, REVIEW_CASE_KEYS } from "../src/server/knowledge/review-context";

describe("fixed three-case intake validation", () => {
  it("has three emerging cases, six sources, fourteen assertions and nine triggers", () => {
    const rows = buildManifest();
    expect(Object.values(rows).map((entries) => entries.length)).toEqual([6, 3, 14, 9]);
    expect(rows.knowledge_cases.every((row) => row.status === "emerging" && row.reviewed_at === null && row.reviewed_by === null)).toBe(true);
    expect(buildManifest()).toEqual(rows);
    expect(stableId("stable")).toBe(stableId("stable"));
  });
  it("rejects promotion, invented review metadata and excerpt storage", () => {
    for (const [table, field, value] of [["knowledge_cases", "status", "verified"], ["knowledge_cases", "reviewed_by", "invented"], ["knowledge_sources", "rights_basis", "invented permission"], ["case_evidence", "source_excerpt", "copied content"]]) {
      const rows = buildManifest(); rows[table][0][field] = value;
      expect(() => validateManifest(rows)).toThrow();
    }
  });
  it("rejects unrelated cases, sources, duplicate identities and unknown SQL fields", () => {
    for (const change of [
      (rows) => { rows.knowledge_cases[0].case_key = "unrelated-case"; },
      (rows) => { rows.knowledge_sources[0].canonical_url = "https://example.com/unreviewed"; },
      (rows) => { rows.case_evidence[1].id = rows.case_evidence[0].id; },
      (rows) => { rows.case_triggers[0]["unexpected_column"] = "value"; },
    ]) { const rows = buildManifest(); change(rows); expect(() => validateManifest(rows)).toThrow(); }
  });
  it("rejects broken source links, cross-case corrections and triggers", () => {
    for (const change of [
      (rows) => { rows.case_evidence[0].source_id = stableId("missing"); },
      (rows) => { rows.case_evidence.find((row) => row.assertion_kind === "correction").related_evidence_id = rows.case_evidence[0].id; },
      (rows) => { rows.case_triggers[0].evidence_id = rows.case_evidence[6].id; },
    ]) { const rows = buildManifest(); change(rows); expect(() => validateManifest(rows)).toThrow(); }
  });
  it("retains rebuttals, a linked attribution correction and labeled contextual inference", () => {
    const rows = buildManifest();
    for (const record of rows.knowledge_cases) expect(rows.case_evidence.some((row) => row.case_id === record.id && row.assertion_kind === "rebuttal")).toBe(true);
    const correction = rows.case_evidence.find((row) => row.assertion_kind === "correction");
    expect(rows.case_evidence.find((row) => row.id === correction.related_evidence_id).assertion_kind).toBe("reported_interpretation");
    expect(rows.case_triggers.every((row) => row.inference_origin === "model_inference" && row.model_id)).toBe(true);
    expect(rows.knowledge_sources.find((row) => row.publisher === "iNews24").provenance_note).toContain("SECONDARY");
  });
  it("separates historical events, publication availability and present discovery", () => {
    const rows = buildManifest();
    const correction = rows.case_evidence.find((row) => row.assertion_kind === "correction");
    expect(correction.observed_at).toBe("2023-11-30T10:37:49Z");
    expect(rows.knowledge_cases.every((row) => row.first_seen_at.startsWith("2026-11-03"))).toBe(true);
    rows.case_evidence[0].observed_at = "2020-01-01T00:00:00Z";
    expect(() => validateManifest(rows)).toThrow();
  });
  it("fails validation before opening a transaction", async () => {
    const rows = buildManifest(); rows.knowledge_cases[0].status = "verified";
    let calls = 0;
    await expect(runIntake({ query: async () => { calls++; } }, { apply: true, manifest: rows })).rejects.toThrow();
    expect(calls).toBe(0);
  });
});

const localUrl = process.env.NARAK_TEST_DATABASE_URL;
describe.skipIf(!localUrl)("intake against a disposable local PostgreSQL registry", () => {
  let client, signature;
  beforeAll(async () => {
    const url = new URL(localUrl);
    if (url.hostname !== "127.0.0.1") throw new Error("Disposable loopback database required");
    client = new pg.Client({ connectionString: localUrl }); await client.connect();
    await client.query(readFileSync("db/migrations/001_knowledge_registry.sql", "utf8"));
    signature = await schemaSignature(client);
  });
  afterAll(async () => { if (client) await client.end(); });
  it("preflights without changing an empty registry", async () => {
    const result = await runIntake(client);
    expect(result.result).toBe("ready"); expect(Object.values(result.counts).every((count) => count === 0)).toBe(true);
  });
  it("inserts exactly the scoped graph with automatic emerging registration events", async () => {
    const result = await runIntake(client, { apply: true });
    expect(result.result).toBe("inserted");
    expect(result.counts).toEqual({ knowledge_sources: 6, knowledge_cases: 3, case_evidence: 14, case_triggers: 9, case_status_events: 3 });
    expect(result.schemaSignature).toBe(signature);
  });
  it("replays without inserts, timestamp changes or extra audit events", async () => {
    const before = await client.query("SELECT to_jsonb(c) AS record FROM narak.knowledge_cases c ORDER BY id");
    const result = await runIntake(client, { apply: true });
    expect(result.result).toBe("unchanged"); expect(result.counts.case_status_events).toBe(3);
    expect((await client.query("SELECT to_jsonb(c) AS record FROM narak.knowledge_cases c ORDER BY id")).rows).toEqual(before.rows);
  });
  it("stops on unexpected rows without altering them", async () => {
    const id = stableId("local-conflict-fixture");
    await client.query("INSERT INTO narak.knowledge_sources (id,canonical_url,title,language_code,discovered_at,discovery_method,discovered_by,provenance_note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [id, "https://example.com/local-fixture", "Local conflict fixture", "en", new Date(), "manual", "test", "Disposable test only"]);
    await expect(runIntake(client, { apply: true })).rejects.toThrow("Unexpected or partial");
    expect((await client.query("SELECT count(*)::int AS count FROM narak.knowledge_sources WHERE id=$1", [id])).rows[0].count).toBe(1);
    await client.query("DELETE FROM narak.knowledge_sources WHERE id=$1", [id]);
  });
  it("stops on conflicting managed content rather than overwriting it", async () => {
    const row = buildManifest().case_evidence[0];
    await client.query("UPDATE narak.case_evidence SET assertion_text=$1 WHERE id=$2", ["Local conflicting content", row.id]);
    await expect(runIntake(client, { apply: true })).rejects.toThrow("differs");
    expect((await client.query("SELECT assertion_text FROM narak.case_evidence WHERE id=$1", [row.id])).rows[0].assertion_text).toBe("Local conflicting content");
    await client.query("UPDATE narak.case_evidence SET assertion_text=$1 WHERE id=$2", [row.assertion_text, row.id]);
  });
  it("retrieves complete source-linked graphs through the actual read-only repository", async () => {
    const repository = createKnowledgeRepository(async (operation) => {
      await client.query("BEGIN READ ONLY");
      try { const data = await operation(client); await client.query("COMMIT"); return { state: "available", data }; }
      catch (error) { await client.query("ROLLBACK"); throw error; }
    });
    expect((await repository.listVerifiedCases()).data).toEqual([]);
    expect((await repository.listEmergingCases()).data).toHaveLength(3);
    for (const record of buildManifest().knowledge_cases) {
      const result = await repository.getCaseById(record.id);
      expect(result.state).toBe("available"); expect(result.data.triggers).toHaveLength(3);
      expect(result.data.evidence.every((row) => row.source.id === row.source_id)).toBe(true);
    }
  });
  it("round-trips Korean trigger text without creating source excerpts", async () => {
    const row = buildManifest().case_triggers[0];
    const result = await client.query("SELECT match_text FROM narak.case_triggers WHERE id=$1", [row.id]);
    expect(result.rows[0].match_text).toContain("\ucc45\uc0c1");
    expect((await client.query("SELECT count(*)::int AS count FROM narak.case_evidence WHERE source_excerpt IS NOT NULL")).rows[0].count).toBe(0);
  });
  it("demonstrates an as-of gate excluding later corrections and anonymous explanations", async () => {
    // The existing repository deliberately returns complete graphs; integration
    // must apply an evidence-availability gate before a historical assessment.
    const query = "SELECT e.evidence_key FROM narak.case_evidence e JOIN narak.knowledge_sources s ON s.id=e.source_id WHERE e.case_id=$1 AND e.observed_at <= $2::timestamptz AND s.published_on <= ($2::timestamptz AT TIME ZONE 'Asia/Seoul')::date";
    const rows = buildManifest().knowledge_cases;
    expect((await client.query(query, [rows[1].id, "2023-11-26T23:59:59+09:00"])).rows.map((row) => row.evidence_key)).toEqual(["nexon-response"]);
    expect((await client.query(query, [rows[1].id, "2023-11-30T23:59:59+09:00"])).rows).toHaveLength(4);
    expect((await client.query(query, [rows[2].id, "2021-05-02T23:59:59+09:00"])).rows).toHaveLength(4);
    expect((await client.query(query, [rows[0].id, "2026-05-18T23:59:59+09:00"])).rows).toHaveLength(3);
  });
  it("keeps human-review requirements and append-only audit protections", async () => {
    for (const query of [
      "UPDATE narak.knowledge_cases SET status='verified'",
      "UPDATE narak.case_status_events SET rationale='forged'",
      "DELETE FROM narak.case_status_events",
    ]) {
      await client.query("BEGIN");
      try { await expect(client.query(query)).rejects.toMatchObject({ code: "23514" }); }
      finally { await client.query("ROLLBACK"); }
    }
    expect(await schemaSignature(client)).toBe(signature);
  });
});

describe.skipIf(process.env.NARAK_VERIFY_HOSTED_INTAKE !== "1")("hosted runtime intake verification (explicit opt-in)", () => {
  let client, repository;
  beforeAll(async () => {
    // Next intentionally skips .env.local under NODE_ENV=test. This explicitly
    // opted-in verification loads only runtime connection settings, never a key.
    const privateEnv = parseEnv(readFileSync(".env.local", "utf8"));
    for (const key of ["DATABASE_URL", "DATABASE_CA_CERT_PATH"]) process.env[key] = privateEnv[key];
    const url = new URL(process.env.DATABASE_URL);
    if (!decodeURIComponent(url.username).startsWith("narak_runtime_reader.") || url.port !== "6543" || !url.hostname.endsWith(".pooler.supabase.com")) throw new Error("Expected dedicated hosted runtime role");
    if (url.searchParams.get("sslmode") !== "verify-full") throw new Error("Verified TLS required");
    url.searchParams.delete("sslmode");
    client = new pg.Client({ connectionString: url.toString(), ssl: { rejectUnauthorized: true, ca: readFileSync(process.env.DATABASE_CA_CERT_PATH, "utf8") }, connectionTimeoutMillis: 10000 });
    await client.connect(); repository = createKnowledgeRepository();
  });
  afterAll(async () => { if (client) await client.end(); });
  it("authenticates the dedicated role with verified TLS and no writable user relations", async () => {
    expect(client.connection.stream.authorized).toBe(true);
    expect((await client.query("SELECT current_user AS role, current_setting('transaction_read_only') AS readonly")).rows[0]).toEqual({ role: "narak_runtime_reader", readonly: "on" });
    const writable = await client.query("SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','f') AND (has_table_privilege(c.oid,'INSERT') OR has_table_privilege(c.oid,'UPDATE') OR has_table_privilege(c.oid,'DELETE') OR has_table_privilege(c.oid,'TRUNCATE'))");
    expect(writable.rows[0].count).toBe(0);
  });
  it("retrieves all three emerging graphs and zero verified cases through the actual runtime repository", async () => {
    const emerging = await repository.listEmergingCases();
    expect(emerging.state).toBe("available"); expect(emerging.data).toHaveLength(3);
    expect(await repository.listVerifiedCases()).toEqual({ state: "available", data: [] });
    for (const record of buildManifest().knowledge_cases) {
      const detail = await repository.getCaseById(record.id);
      expect(detail.state).toBe("available"); expect(detail.data.case.status).toBe("emerging");
      expect(detail.data.case.reviewed_at).toBeNull(); expect(detail.data.triggers).toHaveLength(3);
      expect(detail.data.evidence).toHaveLength(buildManifest().case_evidence.filter((row) => row.case_id === record.id).length);
      expect(detail.data.evidence.every((row) => row.source_id === row.source.id && row.source_excerpt === null)).toBe(true);
    }
  });
  it("retrieves bounded review candidates and selects only the relevant eligible hosted case", async () => {
    const candidates = await repository.getReviewCases(REVIEW_CASE_KEYS);
    expect(candidates.state).toBe("available"); expect(candidates.data).toHaveLength(3);
    const selected = selectRegistryContext({ copy: "GS25 Emotional Camping Must-have Item", publicationDate: "2026-11-04", market: "KR" }, [], candidates);
    expect(selected.state).toBe("available"); expect(selected.matchedCaseIds).toHaveLength(1);
    expect(selected.evidence).toHaveLength(5);
    expect(selected.evidence.every((row) => row.caseStatus === "emerging")).toBe(true);
  });
  it("retains hosted Unicode, six sources, fourteen assertions, nine triggers and three audit events", async () => {
    for (const [table, count] of [["knowledge_cases", 3], ["knowledge_sources", 6], ["case_evidence", 14], ["case_triggers", 9], ["case_status_events", 3]]) {
      expect((await client.query(`SELECT count(*)::int AS count FROM narak.${table}`)).rows[0].count).toBe(count);
    }
    const row = buildManifest().case_triggers[0];
    expect((await client.query("SELECT match_text FROM narak.case_triggers WHERE id=$1", [row.id])).rows[0].match_text).toBe(row.match_text);
    expect(await schemaSignature(client)).toMatch(/^[a-f0-9]{64}$/);
  });
  it("rejects actual writes to all five tables even in explicit read-write transactions", async () => {
    for (const table of ["knowledge_cases", "knowledge_sources", "case_evidence", "case_triggers", "case_status_events"]) {
      await client.query("BEGIN READ WRITE");
      try { await expect(client.query(`DELETE FROM narak.${table} WHERE false`)).rejects.toMatchObject({ code: "42501" }); }
      finally { await client.query("ROLLBACK"); }
    }
  });
});
