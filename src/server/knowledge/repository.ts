import "server-only";
import { z } from "zod";
import { withKnowledgeRead } from "./database";
import {
  caseEvidenceSchema, caseTriggerSchema, knowledgeCaseSchema,
  type KnowledgeCaseDetail, type KnowledgeReader,
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
    getReviewCases(caseKeys: string[]) {
      z.array(z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)).min(1).max(3).parse(caseKeys);
      return read<KnowledgeCaseDetail[]>(async (connection) => {
        const result = await connection.query(
          `SELECT to_jsonb(c) AS record,
            (SELECT coalesce(jsonb_agg(e.record ORDER BY e.observed_at, e.id), '[]'::jsonb) FROM (
              SELECT to_jsonb(e) || jsonb_build_object('source', to_jsonb(s)) AS record, e.observed_at, e.id
              FROM narak.case_evidence e JOIN narak.knowledge_sources s ON s.id=e.source_id
              WHERE e.case_id=c.id ORDER BY e.observed_at, e.id LIMIT 21
            ) e) AS evidence,
            (SELECT coalesce(jsonb_agg(t.record ORDER BY t.id), '[]'::jsonb) FROM (
              SELECT to_jsonb(t) AS record, t.id FROM narak.case_triggers t
              WHERE t.case_id=c.id ORDER BY t.id LIMIT 13
            ) t) AS triggers
           FROM narak.knowledge_cases c WHERE c.case_key = ANY($1::text[])
             AND c.market=$2 AND c.status IN ($3,$4) ORDER BY c.case_key LIMIT 4`,
          [caseKeys, "KR", "emerging", "verified"],
        );
        return result.rows.map((row) => {
          const parsed = z.object({ record: z.unknown(), evidence: z.array(z.unknown()).max(20), triggers: z.array(z.unknown()).max(12) }).parse(row);
          return { case: knowledgeCaseSchema.parse(parsed.record), evidence: parsed.evidence.map((entry) => caseEvidenceSchema.parse(entry)), triggers: parsed.triggers.map((entry) => caseTriggerSchema.parse(entry)) };
        });
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
