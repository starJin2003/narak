import { z } from "zod";

export const MAX_COPY_LENGTH = 5_000;
// Leave multipart/copy headroom below Vercel's 4.5 MB function-body ceiling.
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 20_000_000;
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
// Fits a 210-second Node route with room for upload parsing and response cleanup.
export const REVIEW_TIMEOUT_MS = 180_000;

export const outcomeSchema = z.enum([
  "evidence_backed_concern",
  "emerging_signal",
  "no_supported_concern_found",
]);

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export const inputFieldsSchema = z.object({
  copy: z.string().max(MAX_COPY_LENGTH, "Keep advertisement copy to 5,000 characters or fewer."),
  publicationDate: z.string().refine(isCalendarDate, "Choose a valid publication date."),
  market: z.literal("KR"),
});

export function isSafeSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

// Preserve the provider's original annotation, including additional metadata.
export const citationAnnotationSchema = z.object({
  type: z.literal("url_citation"),
  url: z.string().max(8_192).refine(isSafeSourceUrl),
  title: z.string().max(2_000),
  start_index: z.number().int().nonnegative(),
  end_index: z.number().int().positive(),
}).passthrough();

export const sourceSchema = z.object({
  id: z.string(),
  evidenceState: z.literal("unverified"),
  responseId: z.string(),
  messageId: z.string(),
  blockIndex: z.number().int().nonnegative(),
  annotation: citationAnnotationSchema,
  citedPassage: z.string().min(1).max(30_000),
});

export const searchCallSchema = z.object({
  id: z.string(),
  status: z.enum(["in_progress", "searching", "completed", "failed"]),
  action: z.record(z.string(), z.unknown()).optional(),
});

const prose = z.string().min(1).max(2_000);
export const observationSchema = z.object({
  kind: z.enum(["image", "copy", "date"]),
  description: prose,
}).strict();

export const findingSchema = z.object({
  title: z.string().min(1).max(160),
  observedElement: prose,
  reportedClaim: prose,
  reportedInterpretation: prose,
  counterarguments: z.array(prose).max(6),
  modelInference: prose,
  sourceIds: z.array(z.string().min(1)).min(1).max(12),
}).strict();

export const assessmentSchema = z.object({
  assessmentStatus: z.enum(["complete", "insufficient"]),
  observations: z.array(observationSchema).max(12),
  findings: z.array(findingSchema).max(8),
  evidenceScope: prose,
  limitations: z.array(prose).max(8),
}).strict();

export const scopeSchema = z.object({
  market: z.literal("KR"),
  publicationDate: z.string(),
  checkedAt: z.string(),
  hasImage: z.boolean(),
  hasCopy: z.boolean(),
  completedSearches: z.number().int().nonnegative(),
  citedSources: z.number().int().nonnegative(),
  description: z.string(),
});

// Registry notes never have provider response IDs, character spans or annotations.
export const registryEvidenceSchema = z.object({
  id: z.string().regex(/^R[1-9][0-9]*$/), caseId: z.uuid(), evidenceId: z.uuid(),
  caseStatus: z.enum(["emerging", "verified"]), sourceId: z.uuid(),
  canonicalUrl: z.string().max(8192).refine(isSafeSourceUrl), title: z.string().max(1000),
  publisher: z.string().max(300).nullable(), publishedOn: z.iso.date(), availableAt: z.iso.datetime({ offset: true }),
  assertionKind: z.enum(["reported_fact", "reported_interpretation", "rebuttal", "correction"]),
  assertionText: z.string().min(1).max(4000), attribution: z.string().min(1).max(500),
  provenance: z.string().min(1).max(2000), relatedEvidenceId: z.uuid().nullable(),
}).strict();

export const registryContextSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("available"), checkedCases: z.number().int().min(0).max(3),
    matchedCaseIds: z.array(z.uuid()).max(3), evidence: z.array(registryEvidenceSchema).max(60),
  }).strict(),
  z.object({
    state: z.literal("unavailable"), code: z.enum(["not_configured", "invalid_configuration", "database_unavailable", "bounded_context_exceeded"]),
  }).strict(),
]);

export type RegistryContext = z.infer<typeof registryContextSchema>;

export const resultSchema = z.object({
  outcome: outcomeSchema,
  summary: prose,
  observations: z.array(observationSchema),
  findings: z.array(findingSchema),
  sources: z.array(sourceSchema).min(1),
  registry: registryContextSchema.default({ state: "unavailable", code: "not_configured" }),
  searchCalls: z.array(searchCallSchema).min(1),
  scope: scopeSchema,
  limitations: z.array(prose),
  verifiedCaseIds: z.array(z.string().min(1)),
}).superRefine((result, context) => {
  const registryEvidence = result.registry.state === "available" ? result.registry.evidence : [];
  const sourceIds = [...result.sources.map((source) => source.id), ...registryEvidence.map((source) => source.id)];
  const ids = new Set(sourceIds);
  if (ids.size !== sourceIds.length || result.sources.some((source) => !/^S[1-9][0-9]*$/.test(source.id))) {
    context.addIssue({ code: "custom", message: "Source namespaces must be distinct and unique." });
  }
  if (result.findings.some((finding) => finding.sourceIds.some((id) => !ids.has(id)))) {
    context.addIssue({ code: "custom", message: "A finding references an unknown source." });
  }
  if (result.outcome === "evidence_backed_concern" && !result.verifiedCaseIds.length) {
    context.addIssue({ code: "custom", message: "Verified case records are required." });
  }
  const verifiedIds = new Set(registryEvidence.filter((entry) => entry.caseStatus === "verified").map((entry) => entry.caseId));
  if (result.verifiedCaseIds.some((id) => !verifiedIds.has(id))) {
    context.addIssue({ code: "custom", message: "Verified case IDs must come from supplied verified registry records." });
  }
  if (result.outcome === "no_supported_concern_found" && result.findings.length) {
    context.addIssue({ code: "custom", message: "A negative finding cannot contain concerns." });
  }
  if (result.outcome === "no_supported_concern_found" && result.registry.state === "unavailable") {
    context.addIssue({ code: "custom", message: "An unavailable registry cannot support a complete negative finding." });
  }
  if (result.outcome === "emerging_signal" && !result.findings.length) {
    context.addIssue({ code: "custom", message: "An emerging signal needs a cited finding." });
  }
  if (result.searchCalls.some((call) => call.status !== "completed")) {
    context.addIssue({ code: "custom", message: "Retrieval did not complete." });
  }
});

export const issueSchema = z.object({
  code: z.enum([
    "invalid_input", "missing_credentials", "authentication", "rate_limit",
    "timeout", "provider_unavailable", "unsupported_request", "invalid_response",
    "retrieval_incomplete", "insufficient_sources", "assessment_incomplete", "cancelled",
  ]),
  message: z.string(),
  retryable: z.boolean(),
  field: z.enum(["copy", "publicationDate", "image"]).optional(),
});

export const reviewResponseSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("completed"), result: resultSchema }),
  z.object({
    state: z.enum(["incomplete", "unavailable", "failed"]),
    result: z.null(),
    issue: issueSchema,
  }),
]);

export type ReviewResponse = z.infer<typeof reviewResponseSchema>;
export type ReviewResult = z.infer<typeof resultSchema>;
export type ReviewIssue = z.infer<typeof issueSchema>;
export type ReviewSource = z.infer<typeof sourceSchema>;
export type SearchCall = z.infer<typeof searchCallSchema>;
export type Assessment = z.infer<typeof assessmentSchema>;
export type ReviewInput = z.infer<typeof inputFieldsSchema> & {
  image?: { mediaType: typeof IMAGE_TYPES[number]; dataUrl: string };
};
