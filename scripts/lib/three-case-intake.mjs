import { createHash } from "node:crypto";
import { z } from "zod";
import { cases, sources, discoveredAt } from "../data/three-case-intake.mjs";

const tables = ["knowledge_sources", "knowledge_cases", "case_evidence", "case_triggers"];
const expectedCounts = [6, 3, 14, 9];
const allowedCases = ["starbucks-kr-tank-day-2026-05-18", "maplestory-angelic-buster-frame-2023-11", "gs25-camping-poster-2021-05"];
const allowedUrls = [
  "https://www.mt.co.kr/living/2026/05/18/2026051814054774713",
  "https://biz.chosun.com/distribution/channel/2026/05/26/C6WSJCO5NBHS5DY5KIS3DL36C4/",
  "https://www.inven.co.kr/webzine/news/?news=290842",
  "https://www.inews24.com/view/1660539",
  "https://www.edaily.co.kr/News/Read?mediaCodeNo=257&newsId=02148406629044984",
  "https://www.newspim.com/news/view/20210510000585",
];

// UUID v5, fixed namespace and names: identities do not depend on insertion order.
export function stableId(name) {
  const namespace = Buffer.from("e6bc14a9e0e54ef287280caa98c847a2", "hex");
  const bytes = createHash("sha1").update(namespace).update(name).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function buildManifest() {
  const sourceByKey = new Map(sources.map((source) => [source.key, source]));
  const rows = { knowledge_sources: [], knowledge_cases: [], case_evidence: [], case_triggers: [] };
  for (const source of sources) {
    rows.knowledge_sources.push({
      id: stableId(source.canonical_url), canonical_url: source.canonical_url,
      title: source.title, publisher: source.publisher, language_code: "ko",
      published_on: source.published_on, discovered_at: discoveredAt,
      discovery_method: "manual", discovered_by: "task-02d-1-supervised-intake",
      provenance_note: source.provenance_note, provider_response_id: null,
      storage_rights: "metadata_only", rights_basis: null, rights_reviewed_by: null, rights_reviewed_at: null,
    });
  }
  for (const record of cases) {
    const caseId = stableId(record.case_key);
    rows.knowledge_cases.push({
      id: caseId, case_key: record.case_key, title: record.title, context_summary: record.context_summary,
      status: "emerging", market: "KR", event_start_date: record.event_start_date, event_end_date: null,
      first_seen_at: discoveredAt, last_seen_at: discoveredAt,
      reviewed_at: null, reviewed_by: null, review_method: null, review_rationale: null,
    });
    for (const evidence of record.evidence) {
      const source = sourceByKey.get(evidence.source);
      if (!source) throw new Error("Unknown manifest source");
      rows.case_evidence.push({
        id: stableId(`${record.case_key}/evidence/${evidence.key}`), case_id: caseId,
        evidence_key: evidence.key, source_id: stableId(source.canonical_url),
        assertion_kind: evidence.kind, assertion_text: evidence.text, attribution: evidence.attribution,
        model_id: null, source_locator: "Article reporting; see publication and attribution notes in source provenance.",
        source_excerpt: null,
        related_evidence_id: evidence.related ? stableId(`${record.case_key}/evidence/${evidence.related}`) : null,
        observed_at: source.available_at,
      });
    }
    for (const trigger of record.triggers) {
      const evidence = record.evidence.find((entry) => entry.key === trigger.evidence);
      rows.case_triggers.push({
        id: stableId(`${record.case_key}/trigger/${trigger.key}`), case_id: caseId, trigger_key: trigger.key,
        evidence_id: stableId(`${record.case_key}/evidence/${trigger.evidence}`), trigger_kind: trigger.kind,
        description: trigger.description + " Development context hypothesis, not a reviewed finding.",
        match_text: trigger.match ?? null, publication_start_date: trigger.start ?? null,
        publication_end_date: trigger.end ?? null,
        valid_from: sourceByKey.get(evidence.source).available_at.slice(0, 10), valid_until: null,
        inference_origin: "model_inference", model_id: "development-model-unspecified",
      });
    }
  }
  return validateManifest(rows);
}

const uuid = z.uuid();
const date = z.iso.date();
const time = z.iso.datetime({ offset: true });
const text = (max) => z.string().trim().min(1).max(max);
const schemas = {
  knowledge_sources: z.strictObject({
    id: uuid, canonical_url: z.enum(allowedUrls), title: text(1000), publisher: text(300), language_code: z.literal("ko"),
    published_on: date, discovered_at: time, discovery_method: z.literal("manual"), discovered_by: text(200),
    provenance_note: text(2000), provider_response_id: z.null(), storage_rights: z.literal("metadata_only"),
    rights_basis: z.null(), rights_reviewed_by: z.null(), rights_reviewed_at: z.null(),
  }),
  knowledge_cases: z.strictObject({
    id: uuid, case_key: z.enum(allowedCases), title: text(300), context_summary: text(4000),
    status: z.literal("emerging"), market: z.literal("KR"), event_start_date: date, event_end_date: z.null(),
    first_seen_at: time, last_seen_at: time, reviewed_at: z.null(), reviewed_by: z.null(), review_method: z.null(), review_rationale: z.null(),
  }),
  case_evidence: z.strictObject({
    id: uuid, case_id: uuid, evidence_key: text(200).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/), source_id: uuid,
    assertion_kind: z.enum(["reported_fact", "reported_interpretation", "rebuttal", "correction"]),
    assertion_text: text(4000), attribution: text(500), model_id: z.null(), source_locator: text(1000),
    source_excerpt: z.null(), related_evidence_id: uuid.nullable(), observed_at: time,
  }),
  case_triggers: z.strictObject({
    id: uuid, case_id: uuid, trigger_key: text(200).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/), evidence_id: uuid,
    trigger_kind: z.enum(["copy", "imagery", "publication_date"]), description: text(2000), match_text: text(1000).nullable(),
    publication_start_date: date.nullable(), publication_end_date: date.nullable(), valid_from: date, valid_until: z.null(),
    inference_origin: z.literal("model_inference"), model_id: z.literal("development-model-unspecified"),
  }),
};
function requireValid(condition) { if (!condition) throw new Error("Invalid fixed intake manifest"); }

export function validateManifest(input) {
  requireValid(Object.keys(input).sort().join() === [...tables].sort().join());
  const rows = Object.fromEntries(tables.map((table, index) => [table, z.array(schemas[table]).length(expectedCounts[index]).parse(input[table])]));
  for (const table of tables) requireValid(new Set(rows[table].map((row) => row.id)).size === rows[table].length);
  requireValid(new Set(rows.knowledge_cases.map((row) => row.case_key)).size === 3);
  requireValid(new Set(rows.knowledge_sources.map((row) => row.canonical_url)).size === 6);
  const sourceById = new Map(rows.knowledge_sources.map((row) => [row.id, row]));
  const caseById = new Map(rows.knowledge_cases.map((row) => [row.id, row]));
  const evidenceById = new Map(rows.case_evidence.map((row) => [row.id, row]));
  for (const row of rows.knowledge_sources) requireValid(row.id === stableId(row.canonical_url) && row.published_on <= row.discovered_at.slice(0, 10));
  for (const row of rows.knowledge_cases) {
    requireValid(row.id === stableId(row.case_key) && row.last_seen_at >= row.first_seen_at);
    const evidence = rows.case_evidence.filter((entry) => entry.case_id === row.id);
    requireValid(evidence.some((entry) => entry.assertion_kind === "reported_fact") && evidence.some((entry) => entry.assertion_kind === "rebuttal"));
    requireValid(new Set(evidence.map((entry) => entry.evidence_key)).size === evidence.length);
    const triggers = rows.case_triggers.filter((entry) => entry.case_id === row.id);
    requireValid(triggers.length === 3 && new Set(triggers.map((entry) => entry.trigger_kind)).size === 3);
  }
  for (const row of rows.case_evidence) {
    const source = sourceById.get(row.source_id), record = caseById.get(row.case_id);
    requireValid(source && record && row.id === stableId(`${record.case_key}/evidence/${row.evidence_key}`));
    requireValid(row.observed_at.slice(0, 10) >= source.published_on && Date.parse(row.observed_at) <= Date.parse(source.discovered_at));
    if (row.related_evidence_id) requireValid(evidenceById.get(row.related_evidence_id)?.case_id === row.case_id && row.related_evidence_id !== row.id);
    if (row.assertion_kind === "correction") requireValid(Boolean(row.related_evidence_id));
  }
  for (const row of rows.case_triggers) {
    const evidence = evidenceById.get(row.evidence_id), record = caseById.get(row.case_id);
    requireValid(evidence?.case_id === row.case_id && record && row.id === stableId(`${record.case_key}/trigger/${row.trigger_key}`));
    requireValid(row.valid_from >= evidence.observed_at.slice(0, 10));
    if (row.trigger_kind === "publication_date") requireValid(row.match_text === null && row.publication_start_date && row.publication_end_date >= row.publication_start_date);
    else requireValid(row.match_text && row.publication_start_date === null && row.publication_end_date === null);
  }
  return rows;
}

export class IntakeConflict extends Error {}
const allTables = [...tables, "case_status_events"];
const lockSql = "LOCK TABLE narak.knowledge_sources, narak.knowledge_cases, narak.case_evidence, narak.case_triggers, narak.case_status_events IN SHARE ROW EXCLUSIVE MODE";

export async function schemaSignature(client) {
  const result = await client.query(`
    SELECT 'constraint' AS kind, c.conname AS name, pg_get_constraintdef(c.oid) AS definition, c.convalidated::text AS enabled
    FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'narak' AND c.contype <> 'n'
    UNION ALL SELECT 'trigger', t.tgname, pg_get_triggerdef(t.oid), t.tgenabled::text
    FROM pg_trigger t JOIN pg_class r ON r.oid = t.tgrelid JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE n.nspname = 'narak' AND NOT t.tgisinternal
    UNION ALL SELECT 'function', p.proname, pg_get_functiondef(p.oid), ''
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'narak'
    ORDER BY kind, name, definition`);
  const constraints = result.rows.filter((row) => row.kind === "constraint");
  requireValid(constraints.length === 62 && constraints.every((row) => row.enabled === "true"));
  requireValid(result.rows.filter((row) => row.kind === "trigger" && row.enabled === "O").length === 7);
  requireValid(result.rows.filter((row) => row.kind === "function").length === 5);
  return createHash("sha256").update(JSON.stringify(result.rows)).digest("hex");
}

async function snapshot(client) {
  const state = {};
  for (const table of allTables) state[table] = (await client.query(`SELECT to_jsonb(r) AS record FROM narak.${table} r ORDER BY id`)).rows.map((row) => row.record);
  return state;
}
function equalValue(key, a, b) {
  return key.endsWith("_at") && a !== null && b !== null ? Date.parse(a) === Date.parse(b) : a === b;
}
function stateKind(state, rows) {
  if (allTables.every((table) => state[table].length === 0)) return "empty";
  for (const table of tables) {
    if (state[table].length !== rows[table].length) throw new IntakeConflict("Unexpected or partial registry contents; no changes made");
    const actual = new Map(state[table].map((row) => [row.id, row]));
    for (const row of rows[table]) {
      const found = actual.get(row.id);
      if (!found || !Object.keys(row).every((key) => equalValue(key, row[key], found[key]))) throw new IntakeConflict("Registry differs from fixed manifest; no changes made");
    }
  }
  const events = state.case_status_events;
  if (events.length !== 3 || !rows.knowledge_cases.every((record) => events.filter((event) =>
    event.case_id === record.id && event.from_status === null && event.to_status === "emerging" &&
    event.reviewed_at === null && event.review_method === "registration" && Boolean(event.actor) &&
    event.rationale === "Registered as emerging; not verified.").length === 1)) throw new IntakeConflict("Unexpected registry audit history; no changes made");
  return "complete";
}

export async function runIntake(client, { apply = false, manifest = buildManifest() } = {}) {
  const rows = validateManifest(manifest);
  let open = false;
  try {
    await client.query(apply ? "BEGIN ISOLATION LEVEL SERIALIZABLE" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    open = true;
    await client.query("SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)", ["10000", "5000"]);
    if (apply) await client.query(lockSql);
    const signature = await schemaSignature(client);
    const before = await snapshot(client);
    const kind = stateKind(before, rows);
    if (apply && kind === "empty") {
      for (const table of tables) for (const row of rows[table]) {
        const columns = Object.keys(row);
        await client.query(`INSERT INTO narak.${table} (${columns.join(", ")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`, Object.values(row));
      }
      if (stateKind(await snapshot(client), rows) !== "complete") throw new Error("Intake verification failed");
    }
    if (await schemaSignature(client) !== signature) throw new Error("Registry protections changed");
    const after = await snapshot(client);
    await client.query("COMMIT"); open = false;
    return { result: apply && kind === "empty" ? "inserted" : kind === "complete" ? "unchanged" : "ready", counts: Object.fromEntries(allTables.map((table) => [table, after[table].length])), schemaSignature: signature };
  } catch (error) {
    if (open) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
