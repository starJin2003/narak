import "server-only";
import { z } from "zod";

const id = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const date = z.iso.date();
export const knowledgeCaseSchema = z.object({
  id, case_key: z.string(), title: z.string(), context_summary: z.string(),
  status: z.enum(["emerging", "verified", "rejected", "archived"]), market: z.literal("KR"),
  event_start_date: date.nullable(), event_end_date: date.nullable(),
  first_seen_at: timestamp, last_seen_at: timestamp, created_at: timestamp,
  reviewed_at: timestamp.nullable(), reviewed_by: z.string().nullable(),
  review_method: z.literal("human_review").nullable(), review_rationale: z.string().nullable(),
});

export const knowledgeSourceSchema = z.object({
  id, canonical_url: z.url(), title: z.string(), publisher: z.string().nullable(),
  language_code: z.string(), published_on: date.nullable(), discovered_at: timestamp,
  discovery_method: z.enum(["manual", "meta_web_search"]), discovered_by: z.string(),
  provenance_note: z.string(), provider_response_id: z.string().nullable(),
  storage_rights: z.enum(["metadata_only", "excerpt_permitted"]),
  rights_basis: z.string().nullable(), rights_reviewed_by: z.string().nullable(),
  rights_reviewed_at: timestamp.nullable(), created_at: timestamp,
});

export const caseEvidenceSchema = z.object({
  id, case_id: id, evidence_key: z.string(), source_id: id,
  assertion_kind: z.enum(["reported_fact", "reported_interpretation", "rebuttal", "correction", "model_inference"]),
  assertion_text: z.string(), attribution: z.string(), model_id: z.string().nullable(),
  source_locator: z.string().nullable(), source_excerpt: z.string().nullable(),
  related_evidence_id: id.nullable(), observed_at: timestamp, created_at: timestamp,
  source: knowledgeSourceSchema,
});

export const caseTriggerSchema = z.object({
  id, case_id: id, trigger_key: z.string(), evidence_id: id,
  trigger_kind: z.enum(["copy", "imagery", "publication_date"]), description: z.string(),
  match_text: z.string().nullable(), publication_start_date: date.nullable(),
  publication_end_date: date.nullable(), valid_from: date.nullable(), valid_until: date.nullable(),
  inference_origin: z.enum(["human_review", "model_inference"]), model_id: z.string().nullable(), created_at: timestamp,
});

export type KnowledgeCase = z.infer<typeof knowledgeCaseSchema>;
export type CaseEvidence = z.infer<typeof caseEvidenceSchema>;
export type CaseTrigger = z.infer<typeof caseTriggerSchema>;
export type KnowledgeCaseDetail = {
  case: KnowledgeCase;
  evidence: CaseEvidence[];
  triggers: CaseTrigger[];
};
// Per-case bounds for a review. A larger graph is left out whole and reported as a gap.
export const MAX_CASE_EVIDENCE = 20;
export const MAX_CASE_TRIGGERS = 12;
export type ReviewCandidates = {
  truncated: boolean;
  cases: Array<KnowledgeCaseDetail & { complete: boolean }>;
};
export type KnowledgeRead<T> = { state: "available"; data: T } | {
  state: "unavailable";
  code: "not_configured" | "invalid_configuration" | "database_unavailable";
};

export interface KnowledgeConnection {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}
export type KnowledgeReader = <T>(operation: (connection: KnowledgeConnection) => Promise<T>) => Promise<KnowledgeRead<T>>;
