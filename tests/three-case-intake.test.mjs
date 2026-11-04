import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildManifest, validateManifest, stableId, runIntake, schemaSignature } from "../scripts/lib/three-case-intake.mjs";
import { createKnowledgeRepository } from "../src/server/knowledge/repository";
import { createRegistryRetriever } from "../src/server/knowledge/review-context";

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
  // Lifecycle invariants. They hold however many cases intake adds and however many a person
  // verifies or rejects, so the hosted registry can grow without editing this test.
  it("keeps every case in a valid lifecycle state with one registration and an audited history", async () => {
    const cases = (await client.query("SELECT id, status, reviewed_at, reviewed_by, review_method, review_rationale FROM narak.knowledge_cases")).rows;
    expect(cases.length).toBeGreaterThanOrEqual(buildManifest().knowledge_cases.length);
    for (const row of cases) {
      const events = (await client.query("SELECT from_status, to_status, reviewed_at, actor, review_method FROM narak.case_status_events WHERE case_id=$1 ORDER BY id", [row.id])).rows;
      expect(events[0]).toMatchObject({ from_status: null, to_status: "emerging", review_method: "registration" });
      expect(events.filter((event) => event.review_method === "registration")).toHaveLength(1);
      expect(events.at(-1).to_status).toBe(row.status);
      for (const event of events.slice(1)) {
        expect(event.review_method).toBe("human_review"); expect(event.reviewed_at).not.toBeNull(); expect(event.actor.trim().length).toBeGreaterThan(0);
      }
      if (row.status === "emerging" && events.length === 1) expect(row.reviewed_at).toBeNull();
      if (row.status !== "emerging") expect(row).toMatchObject({ review_method: "human_review", reviewed_at: expect.anything(), reviewed_by: expect.any(String), review_rationale: expect.any(String) });
      if (row.status === "verified") {
        expect((await client.query("SELECT count(*)::int AS count FROM narak.case_evidence WHERE case_id=$1 AND assertion_kind='reported_fact'", [row.id])).rows[0].count).toBeGreaterThan(0);
      }
    }
  });
  it("keeps notes and triggers linked inside their case, labels inference and stores no unapproved excerpt", async () => {
    const one = async (sql) => (await client.query(sql)).rows[0].count;
    expect(await one("SELECT count(*)::int AS count FROM narak.case_evidence e JOIN narak.knowledge_sources s ON s.id=e.source_id WHERE e.source_excerpt IS NOT NULL AND s.storage_rights <> 'excerpt_permitted'")).toBe(0);
    expect(await one("SELECT count(*)::int AS count FROM narak.knowledge_sources WHERE storage_rights = 'excerpt_permitted' AND (rights_reviewed_by IS NULL OR rights_reviewed_at IS NULL)")).toBe(0);
    expect(await one("SELECT count(*)::int AS count FROM narak.case_evidence WHERE (assertion_kind = 'model_inference') <> (model_id IS NOT NULL)")).toBe(0);
    expect(await one("SELECT count(*)::int AS count FROM narak.case_triggers t JOIN narak.case_evidence e ON e.id=t.evidence_id WHERE e.case_id <> t.case_id")).toBe(0);
    expect(await one("SELECT count(*)::int AS count FROM narak.case_triggers WHERE (inference_origin = 'model_inference') <> (model_id IS NOT NULL)")).toBe(0);
  });
  it("still holds every seed row with its reviewed content and Unicode intact", async () => {
    const manifest = buildManifest();
    for (const row of manifest.knowledge_sources) expect((await client.query("SELECT canonical_url FROM narak.knowledge_sources WHERE id=$1", [row.id])).rows[0]?.canonical_url).toBe(row.canonical_url);
    for (const row of manifest.knowledge_cases) expect((await client.query("SELECT case_key FROM narak.knowledge_cases WHERE id=$1", [row.id])).rows[0]?.case_key).toBe(row.case_key);
    for (const row of manifest.case_evidence) expect((await client.query("SELECT assertion_text FROM narak.case_evidence WHERE id=$1", [row.id])).rows[0]?.assertion_text).toBe(row.assertion_text);
    for (const row of manifest.case_triggers) expect((await client.query("SELECT match_text FROM narak.case_triggers WHERE id=$1", [row.id])).rows[0]?.match_text).toBe(row.match_text);
    expect(await schemaSignature(client)).toMatch(/^[a-f0-9]{64}$/);
  });
  it("reads bounded review candidates and selects a seed case by its copy trigger", async () => {
    const candidates = await repository.getReviewCandidates();
    expect(candidates.state).toBe("available");
    expect(candidates.data.cases.length).toBeLessThanOrEqual(50);
    expect(candidates.data.cases.every((item) => ["emerging", "verified"].includes(item.case.status))).toBe(true);
    const camping = buildManifest().knowledge_cases[2];
    const status = (await client.query("SELECT status FROM narak.knowledge_cases WHERE id=$1", [camping.id])).rows[0].status;
    const selected = await createRegistryRetriever(() => repository.getReviewCandidates())(
      { copy: "GS25 Emotional Camping Must-have Item", publicationDate: "2026-11-04", market: "KR" }, [], new AbortController().signal);
    expect(selected.state).toBe("available");
    if (["emerging", "verified"].includes(status)) expect(selected.matchedCaseIds).toContain(camping.id);
    else expect(selected.matchedCaseIds).not.toContain(camping.id);
  });
  it("rejects actual writes to all five tables even in explicit read-write transactions", async () => {
    for (const table of ["knowledge_cases", "knowledge_sources", "case_evidence", "case_triggers", "case_status_events"]) {
      await client.query("BEGIN READ WRITE");
      try { await expect(client.query(`DELETE FROM narak.${table} WHERE false`)).rejects.toMatchObject({ code: "42501" }); }
      finally { await client.query("ROLLBACK"); }
    }
  });
});
