import { z } from "zod";

// Shared with the local log reader. No creative, source, credential or user fields.
export const diagnosticCategorySchema = z.enum([
  "provider_research_envelope_incomplete", "provider_assessment_envelope_incomplete",
  "unfinished_search_items", "missing_search_items", "missing_citations", "invalid_citations",
  "unknown_source_reference", "invalid_assessment", "assessment_insufficient", "registry_unavailable",
  "client_cancelled", "review_deadline_exceeded", "provider_authentication", "provider_quota",
  "provider_billing", "provider_timeout", "provider_transport", "provider_unavailable",
  "unsupported_provider_request", "invalid_provider_response", "missing_credentials", "invalid_input", "unexpected_internal",
]);
export type DiagnosticCategory = z.infer<typeof diagnosticCategorySchema>;
const duration = z.number().int().min(0).max(600_000);
const count = z.number().int().min(0).max(2_000_000);
export const searchCountsSchema = z.strictObject({
  completed: count, searching: count, in_progress: count, failed: count, unknown: count,
});
const stage = z.enum(["research", "assessment"]);
const category = diagnosticCategorySchema.optional();
const payloadSchema = z.discriminatedUnion("event", [
  z.strictObject({ event: z.literal("review_started") }),
  z.strictObject({ event: z.literal("provider_started"), stage }),
  z.strictObject({
    event: z.literal("provider_finished"), stage, durationMs: duration,
    httpStatus: z.number().int().min(100).max(599).optional(),
    providerStatus: z.enum(["completed", "incomplete", "failed", "cancelled", "in_progress", "queued", "unknown"]).optional(),
    searches: searchCountsSchema.optional(), citationAnnotations: count.optional(),
    messages: z.strictObject({ final: count, commentary: count, unknownPhase: count, commentaryCitations: count.optional() }).optional(),
    acceptedSources: count.optional(), rejectedCitations: count.optional(), category,
  }),
  z.strictObject({ event: z.literal("research_checked"), result: z.enum(["accepted", "rejected"]), category }),
  z.strictObject({ event: z.literal("registry_checked"), state: z.enum(["available", "unavailable"]), selectedCases: z.number().int().min(0).max(3).optional(),
    code: z.enum(["not_configured", "invalid_configuration", "database_unavailable", "bounded_context_exceeded"]).optional(), category }),
  z.strictObject({ event: z.literal("assessment_checked"), result: z.enum(["valid", "invalid", "insufficient"]), category }),
  z.strictObject({
    event: z.literal("review_finished"), durationMs: duration,
    state: z.enum(["completed", "incomplete", "unavailable", "failed"]),
    outcome: z.enum(["evidence_backed_concern", "emerging_signal", "no_supported_concern_found"]).optional(), category,
  }),
]);
export type DiagnosticPayload = z.infer<typeof payloadSchema>;
const base = z.object({
  schema: z.literal("narak.review.v1"), reviewId: z.uuid(),
  sequence: z.number().int().min(1).max(64), timestamp: z.iso.datetime(), elapsedMs: duration,
});
// Validate the payload strictly after removing only the fixed envelope fields.
export const diagnosticEventSchema = base.passthrough().transform((value, context) => {
  const { schema, reviewId, sequence, timestamp, elapsedMs, ...payload } = value;
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) { context.addIssue({ code: "custom", message: "Invalid diagnostic payload" }); return z.NEVER; }
  return { schema, reviewId, sequence, timestamp, elapsedMs, ...parsed.data };
});
export type DiagnosticEvent = z.infer<typeof diagnosticEventSchema>;
