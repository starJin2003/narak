import "server-only";
import { z } from "zod";
import { withKnowledgeRead } from "./database";
import { MAX_CANDIDATE_CASES } from "@/lib/review-contract";
import {
  caseEvidenceSchema, caseTriggerSchema, knowledgeCaseSchema, MAX_CASE_EVIDENCE, MAX_CASE_TRIGGERS,
  type KnowledgeCaseDetail, type KnowledgeReader, type ReviewCandidates,
} from "./types";

const recordRow = z.object({ record: z.unknown() });

export function createKnowledgeRepository(read: KnowledgeReader = withKnowledgeRead) {
  function list(status: "verified" | "emerging", limit: number) {
    z.number().int().min(1).max(100).parse(limit);
    return read(async (connection) => {
      const result = await connection.query(
        `SELECT to_jsonb(c) AS record FROM narak.knowledge_cases c
         WHERE c.market = $1 AND c.status = $2
         ORDER BY c.last_seen_at DESC, c.id ASC LIMIT $3`,
        ["KR", status, limit],
      );
      return result.rows.map((row) => knowledgeCaseSchema.parse(recordRow.parse(row).record));
    });
  }

  return {
    // A bounded set of emerging and verified cases, verified first, then the most recently
    // seen. One extra row and per-case counts reveal truncation, which the caller reports as a
    // coverage gap. Each graph carries at most 20 notes and 12 triggers.
    getReviewCandidates(limit = MAX_CANDIDATE_CASES) {
      z.number().int().min(1).max(MAX_CANDIDATE_CASES).parse(limit);
      return read<ReviewCandidates>(async (connection) => {
        const result = await connection.query(
          `SELECT to_jsonb(c) AS record,
            (SELECT count(*)::int FROM narak.case_evidence e WHERE e.case_id=c.id) AS evidence_count,
            (SELECT count(*)::int FROM narak.case_triggers t WHERE t.case_id=c.id) AS trigger_count,
            (SELECT coalesce(jsonb_agg(e.record ORDER BY e.observed_at, e.id), '[]'::jsonb) FROM (
              SELECT to_jsonb(e) || jsonb_build_object('source', to_jsonb(s)) AS record, e.observed_at, e.id
              FROM narak.case_evidence e JOIN narak.knowledge_sources s ON s.id=e.source_id
              WHERE e.case_id=c.id ORDER BY e.observed_at, e.id LIMIT $5
            ) e) AS evidence,
            (SELECT coalesce(jsonb_agg(t.record ORDER BY t.id), '[]'::jsonb) FROM (
              SELECT to_jsonb(t) AS record, t.id FROM narak.case_triggers t
              WHERE t.case_id=c.id ORDER BY t.id LIMIT $6
            ) t) AS triggers
           FROM narak.knowledge_cases c WHERE c.market=$1 AND c.status IN ($2,$3)
           ORDER BY (c.status=$3) DESC, c.last_seen_at DESC, c.id ASC LIMIT $4`,
          ["KR", "emerging", "verified", limit + 1, MAX_CASE_EVIDENCE, MAX_CASE_TRIGGERS],
        );
        const rows = result.rows.map((row) => z.object({
          record: z.unknown(), evidence_count: z.number().int().min(0), trigger_count: z.number().int().min(0),
          evidence: z.array(z.unknown()).max(MAX_CASE_EVIDENCE), triggers: z.array(z.unknown()).max(MAX_CASE_TRIGGERS),
        }).parse(row));
        return {
          truncated: rows.length > limit,
          cases: rows.slice(0, limit).map((row) => ({
            case: knowledgeCaseSchema.parse(row.record),
            evidence: row.evidence.map((entry) => caseEvidenceSchema.parse(entry)),
            triggers: row.triggers.map((entry) => caseTriggerSchema.parse(entry)),
            complete: row.evidence_count <= MAX_CASE_EVIDENCE && row.trigger_count <= MAX_CASE_TRIGGERS,
          })),
        };
      });
    },
    listVerifiedCases: (limit = 25) => list("verified", limit),
    listEmergingCases: (limit = 25) => list("emerging", limit),
    getCaseById(id: string) {
      z.uuid().parse(id);
      return read<KnowledgeCaseDetail | null>(async (connection) => {
        const cases = await connection.query(
          `SELECT to_jsonb(c) AS record FROM narak.knowledge_cases c
           WHERE c.id = $1 AND c.market = $2 AND c.status IN ($3, $4)`,
          [id, "KR", "verified", "emerging"],
        );
        if (!cases.rows.length) return null;
        const record = knowledgeCaseSchema.parse(recordRow.parse(cases.rows[0]).record);
        const evidence = await connection.query(
          `SELECT to_jsonb(e) || jsonb_build_object('source', to_jsonb(s)) AS record
           FROM narak.case_evidence e JOIN narak.knowledge_sources s ON s.id = e.source_id
           WHERE e.case_id = $1 ORDER BY e.observed_at ASC, e.id ASC`, [id],
        );
        const triggers = await connection.query(
          `SELECT to_jsonb(t) AS record FROM narak.case_triggers t
           WHERE t.case_id = $1 ORDER BY t.trigger_kind ASC, t.id ASC`, [id],
        );
        return {
          case: record,
          evidence: evidence.rows.map((row) => caseEvidenceSchema.parse(recordRow.parse(row).record)),
          triggers: triggers.rows.map((row) => caseTriggerSchema.parse(recordRow.parse(row).record)),
        };
      });
    },
  };
}
