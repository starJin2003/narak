import { z } from "zod";

// Human review of one documented case. A person reads the case, its sources, its notes and
// its triggers, then verifies or rejects it with their name and rationale. A dry run reads in a
// read-only transaction and changes nothing. Apply runs in one serializable transaction and
// relies on the database's own guards, which demand fresh human review metadata and a
// source-linked reported fact before a case can be verified. Nothing here runs automatically.

export class ReviewRefused extends Error {}
const refuse = (message) => { throw new ReviewRefused(message); };

const decisionSchema = z.object({
  caseRef: z.string().trim().min(1).max(200),
  decision: z.enum(["verify", "reject"]),
  reviewer: z.string().trim().min(2).max(200),
  rationale: z.string().trim().min(20).max(4000),
}).strict();

const STATUS = { verify: "verified", reject: "rejected" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The full graph of one case, read with parameterized SQL. Bounded so a damaged registry
// cannot flood the terminal.
export async function readCase(client, caseRef, { lock = false } = {}) {
  const byId = UUID.test(caseRef);
  const record = (await client.query(
    `SELECT to_jsonb(c) AS record FROM narak.knowledge_cases c WHERE ${byId ? "c.id = $1::uuid" : "c.case_key = $1"} AND c.market = $2${lock ? " FOR UPDATE" : ""}`,
    [caseRef, "KR"])).rows[0]?.record;
  if (!record) return null;
  const evidence = (await client.query(
    `SELECT to_jsonb(e) || jsonb_build_object('source', to_jsonb(s)) AS record FROM narak.case_evidence e
     JOIN narak.knowledge_sources s ON s.id = e.source_id WHERE e.case_id = $1 ORDER BY e.observed_at, e.id LIMIT 200`, [record.id])).rows.map((row) => row.record);
  const triggers = (await client.query(
    "SELECT to_jsonb(t) AS record FROM narak.case_triggers t WHERE t.case_id = $1 ORDER BY t.trigger_kind, t.id LIMIT 200", [record.id])).rows.map((row) => row.record);
  const events = (await client.query(
    "SELECT to_jsonb(e) AS record FROM narak.case_status_events e WHERE e.case_id = $1 ORDER BY e.id LIMIT 200", [record.id])).rows.map((row) => row.record);
  return { case: record, evidence, triggers, events };
}

// What the reviewer must see before deciding. Model inference is flagged for review.
export function describeCase(detail) {
  const sources = new Map();
  for (const entry of detail.evidence) sources.set(entry.source.id, entry.source);
  const flags = [
    ...detail.triggers.filter((trigger) => trigger.inference_origin === "model_inference").map((trigger) =>
      `Trigger ${trigger.trigger_key} (${trigger.trigger_kind}) was written by model ${trigger.model_id}. Review it before verifying.`),
    ...detail.evidence.filter((entry) => entry.assertion_kind === "model_inference").map((entry) =>
      `Note ${entry.evidence_key} is model inference by ${entry.model_id}. It never counts as a reported fact.`),
    ...(detail.evidence.some((entry) => entry.assertion_kind === "reported_fact") ? [] : ["The case has no reported fact, so the database will refuse verification."]),
  ];
  return {
    case: { id: detail.case.id, key: detail.case.case_key, title: detail.case.title, status: detail.case.status, summary: detail.case.context_summary,
      eventStartDate: detail.case.event_start_date, firstSeenAt: detail.case.first_seen_at, lastSeenAt: detail.case.last_seen_at,
      reviewedBy: detail.case.reviewed_by, reviewedAt: detail.case.reviewed_at },
    sources: [...sources.values()].map((source) => ({ id: source.id, url: source.canonical_url, title: source.title, publisher: source.publisher,
      publishedOn: source.published_on, storageRights: source.storage_rights, provenance: source.provenance_note })),
    evidence: detail.evidence.map((entry) => ({ key: entry.evidence_key, kind: entry.assertion_kind, text: entry.assertion_text,
      attribution: entry.attribution, sourceId: entry.source_id, observedAt: entry.observed_at, correctsKey: entry.related_evidence_id
        ? detail.evidence.find((other) => other.id === entry.related_evidence_id)?.evidence_key ?? entry.related_evidence_id : null })),
    triggers: detail.triggers.map((trigger) => ({ key: trigger.trigger_key, kind: trigger.trigger_kind, matchText: trigger.match_text,
      publication: trigger.publication_start_date ? `${trigger.publication_start_date} to ${trigger.publication_end_date}` : null,
      validFrom: trigger.valid_from, validUntil: trigger.valid_until, origin: trigger.inference_origin, modelId: trigger.model_id, description: trigger.description })),
    history: detail.events.map((event) => ({ from: event.from_status, to: event.to_status, at: event.occurred_at, actor: event.actor, method: event.review_method, rationale: event.rationale })),
    flags,
  };
}

// Dry run by default. With apply, the case must still be emerging, the decision must carry a
// named reviewer and a rationale, and verifying a case with model-written triggers needs the
// reviewer's explicit confirmation that they reviewed those triggers.
export async function runCaseReview(client, input, { apply = false, modelTriggersReviewed = false } = {}) {
  let plan = null;
  if (apply || input.decision !== undefined) {
    const parsed = decisionSchema.safeParse(input);
    if (!parsed.success) refuse(`The decision is incomplete. Check ${parsed.error.issues.map((issue) => issue.path.join(".") || issue.message).join(", ")}. A rationale needs at least 20 characters.`);
    plan = parsed.data;
  } else if (!z.string().trim().min(1).max(200).safeParse(input.caseRef).success) refuse("Name the case by its key or ID");
  let open = false;
  try {
    await client.query(apply ? "BEGIN ISOLATION LEVEL SERIALIZABLE" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    open = true;
    await client.query("SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)", ["10000", "5000"]);
    const detail = await readCase(client, input.caseRef.trim(), { lock: apply });
    if (!detail) refuse(`No case matches ${input.caseRef.trim()}`);
    const report = describeCase(detail);
    if (plan) {
      if (detail.case.status !== "emerging") refuse(`The case is ${detail.case.status}. Only an emerging case can be verified or rejected here`);
      if (plan.decision === "verify" && !detail.evidence.some((entry) => entry.assertion_kind === "reported_fact")) refuse("The case has no reported fact, so it cannot be verified");
      const modelTriggers = detail.triggers.filter((trigger) => trigger.inference_origin === "model_inference");
      if (apply && plan.decision === "verify" && modelTriggers.length && !modelTriggersReviewed) {
        refuse(`${modelTriggers.length} trigger(s) were written by a model. Read them, then add --model-triggers-reviewed to verify`);
      }
    }
    let result = "dry_run";
    if (apply) {
      const updated = await client.query(
        `UPDATE narak.knowledge_cases SET status = $1, reviewed_at = clock_timestamp(), reviewed_by = $2, review_method = 'human_review', review_rationale = $3
         WHERE id = $4 AND status = 'emerging' RETURNING status, reviewed_by, reviewed_at`,
        [STATUS[plan.decision], plan.reviewer, plan.rationale, detail.case.id]);
      if (updated.rows.length !== 1) throw new Error("Review update did not apply");
      const event = (await client.query(
        "SELECT to_status, actor, review_method FROM narak.case_status_events WHERE case_id = $1 ORDER BY id DESC LIMIT 1", [detail.case.id])).rows[0];
      if (!event || event.to_status !== STATUS[plan.decision] || event.actor !== plan.reviewer || event.review_method !== "human_review") throw new Error("Review audit check failed");
      result = "applied";
    }
    await client.query("COMMIT"); open = false;
    return { result, report, decision: plan ? { decision: plan.decision, toStatus: STATUS[plan.decision], reviewer: plan.reviewer, rationale: plan.rationale } : null };
  } catch (error) {
    if (open) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
