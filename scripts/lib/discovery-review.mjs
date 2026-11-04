import { createHash } from "node:crypto";
import { z } from "zod";
import { stableId } from "./three-case-intake.mjs";

// Human review and intake for staged discovery candidates.
//
// Discovery stages candidates in a local file as emerging and unreviewed. A person then
// records a decision for every candidate in a review worksheet next to it. Accepting a
// candidate requires that the reviewer opened the original page, confirmed its
// publication date and confirmed who makes each kept assertion. Intake builds registry
// rows only from accepted candidates, and every case it creates starts as emerging.
// Nothing here can mark a case verified. That stays a separate, audited human review
// inside the database.
export const WORKSHEET_SCHEMA = "narak.discovery-review.v1";
export const INTAKE_ACTOR = "narak-discovery-intake";
const ASSERTION_KINDS = ["reported_fact", "reported_interpretation", "rebuttal", "correction"];
const ALLOWED_ROBOTS = ["allowed", "no_robots_file"];

const isoDate = z.iso.date();
const timestamp = z.iso.datetime({ offset: true });
const slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(120);
const person = z.string().trim().min(2).max(200);
const prose = (max) => z.string().trim().min(1).max(max).refine((value) => !/https?:\/\/|www\./i.test(value), "Write no URLs in reviewed text");

const stagedSchema = z.object({
  schema: z.literal("narak.discovery.v1"),
  createdAt: timestamp,
  topic: z.object({ query: z.string(), before: isoDate, caseKey: slug.nullable() }).strict(),
  model: z.string(),
  researchResponseId: z.string().nullable(),
  reviewState: z.literal("emerging"),
  humanReviewed: z.literal(false),
  candidates: z.array(z.object({
    canonicalUrl: z.url().max(8192),
    title: z.string().max(1000),
    publisher: z.string().max(300).nullable(),
    languageCode: z.string().max(8),
    publishedOn: isoDate.nullable(),
    providerResponseId: z.string().nullable(),
    storageRights: z.literal("metadata_only"),
    robots: z.string(),
    assertions: z.array(z.object({ kind: z.enum(ASSERTION_KINDS), text: z.string().min(1).max(400), attribution: z.string().min(1).max(300) }).passthrough()).min(1).max(4),
    reviewState: z.literal("emerging"),
    humanReviewed: z.literal(false),
  }).passthrough()).max(12),
}).passthrough();

const assertionDecisionSchema = z.object({
  index: z.number().int().min(1).max(4),
  // A kept model paraphrase, or text the reviewer wrote after reading the page.
  origin: z.enum(["model_paraphrase_confirmed", "reviewer_rewrite"]),
  text: prose(1000),
  attribution: prose(500),
  // A correction must name the assertion it corrects, as "D1#2".
  corrects: z.string().regex(/^D[1-9][0-9]*#[1-4]$/).nullable(),
}).strict();

const decisionSchema = z.discriminatedUnion("decision", [
  z.object({
    candidateId: z.string().regex(/^D[1-9][0-9]*$/), canonicalUrl: z.string(), decision: z.literal("accepted"),
    reviewer: person, reviewedAt: timestamp, rationale: prose(2000),
    checks: z.object({ pageRead: z.literal(true), attributionChecked: z.literal(true), publishedOn: isoDate }).strict(),
    publisher: prose(300), title: prose(1000),
    assertions: z.array(assertionDecisionSchema).min(1).max(4),
  }).strict(),
  z.object({
    candidateId: z.string().regex(/^D[1-9][0-9]*$/), canonicalUrl: z.string(), decision: z.literal("rejected"),
    reviewer: person, reviewedAt: timestamp, rationale: prose(2000),
  }).strict(),
]);

const triggerSchema = z.object({
  key: slug, kind: z.enum(["copy", "imagery"]), matchText: prose(1000), description: prose(2000),
  evidence: z.string().regex(/^D[1-9][0-9]*#[1-4]$/),
}).strict();

const caseSchema = z.object({
  caseKey: slug, title: prose(300), contextSummary: prose(4000), eventStartDate: isoDate.nullable(),
  authoredBy: person, authoredAt: timestamp, triggers: z.array(triggerSchema).min(1).max(12),
}).strict();

export const worksheetSchema = z.object({
  schema: z.literal(WORKSHEET_SCHEMA),
  staged: z.object({ file: z.string().min(1).max(300), sha256: z.string().length(64) }).strict(),
  // Every decision is appended. The latest one for a candidate is the current decision.
  history: z.array(decisionSchema).max(200),
  case: caseSchema.nullable(),
}).strict();

export class ReviewRefused extends Error {}
const refuse = (message) => { throw new ReviewRefused(message); };

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

export function parseStaged(text) {
  const parsed = stagedSchema.safeParse(JSON.parse(text));
  if (!parsed.success) refuse("The staged file is not a NARAK discovery file");
  return parsed.data;
}

export function createWorksheet(stagedFile, stagedText) {
  parseStaged(stagedText);
  return { schema: WORKSHEET_SCHEMA, staged: { file: stagedFile, sha256: sha256(stagedText) }, history: [], case: null };
}

function loadPair(worksheet, stagedText) {
  const sheet = worksheetSchema.parse(worksheet);
  if (sheet.staged.sha256 !== sha256(stagedText)) refuse("The staged file changed after its review started. Start a new review");
  return { sheet, staged: parseStaged(stagedText) };
}

const candidateIndex = (id) => Number(id.slice(1)) - 1;

export function currentDecisions(worksheet) {
  const latest = new Map();
  for (const entry of worksheet.history) latest.set(entry.candidateId, entry);
  return latest;
}

// One row per staged candidate, with its current decision and what still blocks intake.
export function reviewStatus(worksheet, stagedText) {
  const { sheet, staged } = loadPair(worksheet, stagedText);
  const latest = currentDecisions(sheet);
  return staged.candidates.map((candidate, index) => {
    const id = `D${index + 1}`;
    const attributionGaps = candidate.assertions.flatMap((assertion, at) => namesPublisher(assertion.attribution, candidate.publisher) ? [] : [at + 1]);
    return {
      candidateId: id, canonicalUrl: candidate.canonicalUrl, title: candidate.title, publisher: candidate.publisher,
      publishedOn: candidate.publishedOn, robots: candidate.robots, decision: latest.get(id)?.decision ?? "pending",
      assertions: candidate.assertions.map((assertion, at) => ({ ref: `${id}#${at + 1}`, kind: assertion.kind, text: assertion.text, attribution: assertion.attribution })),
      attributionNeedsPublisher: attributionGaps.map((at) => `${id}#${at}`),
    };
  });
}

function namesPublisher(attribution, publisher) {
  return Boolean(publisher) && attribution.toLowerCase().includes(publisher.toLowerCase());
}

// Records a reviewer's decision. Accepting needs the page read, the date and the
// attribution checked, and every kept assertion to name the publisher that reports it.
export function recordDecision(worksheet, stagedText, input, now = new Date()) {
  const { sheet, staged } = loadPair(worksheet, stagedText);
  const index = candidateIndex(input.candidateId ?? "");
  const candidate = staged.candidates[index];
  if (!candidate) refuse(`There is no candidate ${input.candidateId}`);
  const base = { candidateId: input.candidateId, canonicalUrl: candidate.canonicalUrl, reviewer: input.reviewer, reviewedAt: now.toISOString(), rationale: input.rationale };
  let entry;
  if (input.decision === "rejected") {
    entry = { ...base, decision: "rejected" };
  } else if (input.decision === "accepted") {
    if (!ALLOWED_ROBOTS.includes(candidate.robots)) refuse("This candidate's robots check did not allow Meta agents, so it cannot be accepted");
    if (input.pageRead !== true || input.attributionChecked !== true) refuse("Accepting needs confirmation that you read the original page and checked who makes each assertion");
    const publishedOn = input.publishedOn ?? "";
    if (!isoDate.safeParse(publishedOn).success) refuse("Accepting needs the publication date you confirmed on the page, as YYYY-MM-DD");
    if (publishedOn >= staged.topic.before) refuse(`The confirmed date ${publishedOn} is not before the discovery cutoff ${staged.topic.before}`);
    const publisher = (input.publisher ?? candidate.publisher ?? "").trim();
    if (!publisher) refuse("Accepting needs the publisher's name");
    const keep = input.keep ?? [];
    if (!keep.length) refuse("Accepting needs at least one assertion you confirmed against the page");
    const rewrites = input.rewrites ?? {};
    const assertions = keep.map((at) => {
      const original = candidate.assertions[at - 1];
      if (!original) refuse(`Candidate ${input.candidateId} has no assertion ${at}`);
      const rewrite = rewrites[at] ?? {};
      const attribution = (rewrite.attribution ?? original.attribution).trim();
      if (!namesPublisher(attribution, publisher)) {
        refuse(`Assertion ${input.candidateId}#${at} is attributed to "${attribution}". Name who says it and the publisher that reports it, for example "Some viewers, as reported by ${publisher}"`);
      }
      const corrects = rewrite.corrects ?? null;
      if (original.kind === "correction" && !corrects) refuse(`Correction ${input.candidateId}#${at} needs the assertion it corrects`);
      if (original.kind !== "correction" && corrects) refuse(`Only a correction can point at another assertion, and ${input.candidateId}#${at} is a ${original.kind.replace("_", " ")}`);
      return { index: at, origin: rewrite.text || rewrite.attribution ? "reviewer_rewrite" : "model_paraphrase_confirmed", text: (rewrite.text ?? original.text).trim(), attribution, corrects };
    });
    entry = { ...base, decision: "accepted", checks: { pageRead: true, attributionChecked: true, publishedOn }, publisher, title: (input.title ?? candidate.title).trim(), assertions };
  } else refuse("Choose accept or reject");
  const parsed = decisionSchema.safeParse(entry);
  if (!parsed.success) refuse(`The decision is incomplete. Check ${parsed.error.issues.map((issue) => issue.path.join(".") || issue.message).join(", ")}`);
  return worksheetSchema.parse({ ...sheet, history: [...sheet.history, parsed.data] });
}

export function setCase(worksheet, stagedText, input, now = new Date()) {
  const { sheet } = loadPair(worksheet, stagedText);
  const parsed = caseSchema.safeParse({ ...input, authoredAt: now.toISOString() });
  if (!parsed.success) refuse(`The case record is incomplete. Check ${parsed.error.issues.map((issue) => issue.path.join(".") || issue.message).join(", ")}`);
  return worksheetSchema.parse({ ...sheet, case: parsed.data });
}

// Midnight in Seoul on the publication day, the earliest moment a source could be known.
const seoulMidnight = (date) => new Date(`${date}T00:00:00+09:00`).toISOString();

export function buildDiscoveryManifest(worksheet, stagedText, now = new Date()) {
  const { sheet, staged } = loadPair(worksheet, stagedText);
  if (!sheet.case) refuse("Record the case title, summary and triggers before intake");
  const latest = currentDecisions(sheet);
  const pending = staged.candidates.map((_, index) => `D${index + 1}`).filter((id) => !latest.has(id));
  if (pending.length) refuse(`Every staged candidate needs a decision before intake. ${pending.join(", ")} still ${pending.length === 1 ? "needs" : "need"} one`);
  const accepted = [...latest.values()].filter((entry) => entry.decision === "accepted").sort((a, b) => candidateIndex(a.candidateId) - candidateIndex(b.candidateId));
  if (!accepted.length) refuse("No candidate was accepted, so there is nothing to add");
  const { caseKey } = sheet.case;
  const intakeAt = now.toISOString();
  const caseId = stableId(caseKey);
  const evidenceKey = (ref) => ref.toLowerCase().replace("#", "-assertion-").replace(/^d/, "source-");
  const evidenceId = (ref) => stableId(`${caseKey}/evidence/${evidenceKey(ref)}`);
  const keptRefs = new Map();
  const rows = { knowledge_sources: [], knowledge_cases: [], case_evidence: [], case_triggers: [] };
  for (const decision of accepted) {
    const candidate = staged.candidates[candidateIndex(decision.candidateId)];
    rows.knowledge_sources.push({
      id: stableId(candidate.canonicalUrl), canonical_url: candidate.canonicalUrl, title: decision.title, publisher: decision.publisher,
      language_code: /^[a-z]{2,3}$/.test(candidate.languageCode) ? candidate.languageCode : "und",
      published_on: decision.checks.publishedOn, discovered_at: staged.createdAt, discovery_method: "meta_web_search",
      discovered_by: "narak-discovery-cli",
      provenance_note: `Found by ${staged.model} web search${candidate.providerResponseId ? ` (response ${candidate.providerResponseId})` : ""} on ${staged.createdAt.slice(0, 10)}. ${decision.reviewer} read the page on ${decision.reviewedAt.slice(0, 10)} and confirmed the publication date and attribution. Assertions are paraphrases, not quotations. Reviewer note: ${decision.rationale}`.slice(0, 2000),
      provider_response_id: candidate.providerResponseId, storage_rights: "metadata_only", rights_basis: null, rights_reviewed_by: null, rights_reviewed_at: null,
    });
    for (const assertion of decision.assertions) {
      const ref = `${decision.candidateId}#${assertion.index}`;
      keptRefs.set(ref, { decision, assertion, kind: candidate.assertions[assertion.index - 1].kind });
    }
  }
  if (![...keptRefs.values()].some((item) => item.kind === "reported_fact")) refuse("Keep at least one reported fact. A case needs one before it can ever be verified");
  rows.knowledge_cases.push({
    id: caseId, case_key: caseKey, title: sheet.case.title, context_summary: sheet.case.contextSummary, status: "emerging", market: "KR",
    event_start_date: sheet.case.eventStartDate, event_end_date: null, first_seen_at: intakeAt, last_seen_at: intakeAt,
    reviewed_at: null, reviewed_by: null, review_method: null, review_rationale: null,
  });
  for (const [ref, { decision, assertion, kind }] of keptRefs) {
    if (assertion.corrects && !keptRefs.has(assertion.corrects)) refuse(`${ref} corrects ${assertion.corrects}, which was not kept`);
    if (assertion.corrects && keptRefs.get(assertion.corrects).kind === "correction") refuse(`${ref} corrects another correction. Link it to the original assertion`);
    rows.case_evidence.push({
      id: evidenceId(ref), case_id: caseId, evidence_key: evidenceKey(ref), source_id: stableId(decision.canonicalUrl),
      assertion_kind: kind, assertion_text: assertion.text, attribution: assertion.attribution,
      // The text is a reviewed paraphrase. model_id stays null because the schema reserves it for model inference.
      model_id: null, source_locator: "Original page, read by the reviewer named in the source provenance.", source_excerpt: null,
      related_evidence_id: assertion.corrects ? evidenceId(assertion.corrects) : null, observed_at: seoulMidnight(decision.checks.publishedOn),
    });
  }
  for (const trigger of sheet.case.triggers) {
    const kept = keptRefs.get(trigger.evidence);
    if (!kept) refuse(`Trigger ${trigger.key} points at ${trigger.evidence}, which was not kept`);
    rows.case_triggers.push({
      id: stableId(`${caseKey}/trigger/${trigger.key}`), case_id: caseId, trigger_key: trigger.key, evidence_id: evidenceId(trigger.evidence),
      trigger_kind: trigger.kind, description: `${trigger.description} Relevance hypothesis written by ${sheet.case.authoredBy}, not a finding.`.slice(0, 2000),
      match_text: trigger.matchText, publication_start_date: null, publication_end_date: null,
      valid_from: kept.decision.checks.publishedOn, valid_until: null, inference_origin: "human_review", model_id: null,
    });
  }
  if (!rows.case_triggers.some((row) => row.trigger_kind === "copy")) refuse("Add at least one copy trigger. Reviews select documented cases by their copy triggers");
  // Corrections go after the rows they correct, so the foreign key holds at every insert.
  rows.case_evidence.sort((a, b) => Number(Boolean(a.related_evidence_id)) - Number(Boolean(b.related_evidence_id)));
  return rows;
}

export class IntakeConflict extends Error {}
const TABLES = ["knowledge_sources", "knowledge_cases", "case_evidence", "case_triggers"];

// Adds one reviewed emerging case. Without apply it only checks, inside a read-only
// transaction. With apply it inserts in one serializable transaction and reads the rows
// back. Existing rows are never updated, so a conflict stops the intake unchanged.
export async function runDiscoveryIntake(client, rows, { apply = false } = {}) {
  let open = false;
  try {
    await client.query(apply ? "BEGIN ISOLATION LEVEL SERIALIZABLE" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    open = true;
    await client.query("SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)", ["10000", "5000"]);
    if (apply) await client.query("LOCK TABLE narak.knowledge_sources, narak.knowledge_cases, narak.case_evidence, narak.case_triggers IN SHARE ROW EXCLUSIVE MODE");
    const [record] = rows.knowledge_cases;
    const existingCase = await client.query("SELECT status FROM narak.knowledge_cases WHERE case_key = $1 OR id = $2", [record.case_key, record.id]);
    if (existingCase.rows.length) throw new IntakeConflict(`Case ${record.case_key} already exists; no changes made`);
    const urls = rows.knowledge_sources.map((row) => row.canonical_url);
    const existingSources = await client.query("SELECT canonical_url FROM narak.knowledge_sources WHERE canonical_url = ANY($1::text[]) OR id = ANY($2::uuid[])", [urls, rows.knowledge_sources.map((row) => row.id)]);
    if (existingSources.rows.length) throw new IntakeConflict(`${existingSources.rows.length} source page(s) are already in the registry; no changes made`);
    if (apply) {
      for (const table of TABLES) for (const row of rows[table]) {
        const columns = Object.keys(row);
        await client.query(`INSERT INTO narak.${table} (${columns.join(", ")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`, Object.values(row));
      }
      const check = await client.query(`SELECT c.status,
        (SELECT count(*)::int FROM narak.case_evidence e WHERE e.case_id = c.id) AS evidence,
        (SELECT count(*)::int FROM narak.case_triggers t WHERE t.case_id = c.id) AS triggers,
        (SELECT count(*)::int FROM narak.case_status_events s WHERE s.case_id = c.id AND s.to_status = 'emerging' AND s.review_method = 'registration') AS registrations
        FROM narak.knowledge_cases c WHERE c.id = $1`, [record.id]);
      const row = check.rows[0];
      if (!row || row.status !== "emerging" || row.evidence !== rows.case_evidence.length || row.triggers !== rows.case_triggers.length || row.registrations !== 1) {
        throw new Error("Intake verification failed");
      }
    }
    await client.query("COMMIT"); open = false;
    return { result: apply ? "inserted" : "ready", caseKey: record.case_key, status: "emerging",
      counts: { sources: rows.knowledge_sources.length, cases: 1, evidence: rows.case_evidence.length, triggers: rows.case_triggers.length } };
  } catch (error) {
    if (open) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
