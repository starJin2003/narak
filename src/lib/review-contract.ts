import { z } from "zod";

export const MAX_COPY_LENGTH = 5_000;
// Leaves multipart and copy headroom below the 4.5 MB hosting limit in transport.ts.
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 20_000_000;
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
// One research retry needs room for a second research call, the registry imagery check and
// an assessment after the first research fails. Measured maximums on 2026-11-04 were 89.6 s
// for research and 46.7 s for an assessment at low effort. The review deadline leaves 3 s of
// margin, so a first research call of up to 92 s can still retry. The 280 s route limit
// leaves room for upload parsing and the response, inside the 300 s Vercel Hobby maximum.
export const REVIEW_TIMEOUT_MS = 255_000;
export const RESEARCH_RESERVE_MS = 90_000;
// Raised from 40 s after a control assessment measured 46.7 s on 2026-11-04.
export const ASSESSMENT_RESERVE_MS = 50_000;
// The one low effort registry imagery check that runs between research and assessment.
export const SELECTION_RESERVE_MS = 20_000;

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

// NARAK reviews cultural, historical and social meaning only. The assessment labels every
// finding, and the server removes the types outside that scope.
export const CONCERN_TYPES = [
  "cultural_meaning", "historical_meaning", "social_meaning",
  "product_or_performance_claim", "certification", "usage_or_safety", "pricing", "legal_or_regulatory", "other",
] as const;
export const IN_SCOPE_CONCERNS: ReadonlySet<string> = new Set(["cultural_meaning", "historical_meaning", "social_meaning"]);
// A documented sensitive date is one day or a period of at most this many days.
export const MAX_DOCUMENTED_DATE_DAYS = 31;
// What a reaction source reports. Only a real public reaction or documented sensitivity
// involving an advertisement, a campaign or another public use counts. General guides and
// symbol explanations do not.
export const REACTION_KINDS = [
  "reaction_to_advertisement_or_campaign", "reaction_to_other_public_use", "documented_sensitivity_in_public_use",
  "general_guide_or_symbol_explanation",
] as const;
export const DOCUMENTED_REACTIONS: ReadonlySet<string> = new Set(REACTION_KINDS.slice(0, 3));
// How an image finding matches the creative. Colors alone and ambiguous shapes never count.
export const VISUAL_MATCHES = ["not_visual", "clear_visible_match", "color_only", "ambiguous_shape"] as const;
// Why an assessment could not be completed. A creative with no relevant documented concern
// in completed cited research is a complete scoped negative, never insufficient.
export const INSUFFICIENT_REASONS = ["none", "conflicting_evidence", "creative_not_assessable", "other"] as const;
export const COPY_PHRASE_MAX = 500;
// Words visible in the poster, transcribed by the research call. Untrusted data, bounded.
export const VISIBLE_TEXT_MAX_LINES = 40;
export const VISIBLE_TEXT_MAX_LINE = 200;

// Encyclopedia hosts, matched on the host or any subdomain. A finding whose only reaction
// sources are pages on these hosts is removed, because an encyclopedia entry summarizes a
// reaction rather than reporting it.
export const ENCYCLOPEDIA_HOSTS = [
  "wikipedia.org", "wikiwand.com", "namu.wiki", "britannica.com", "encyclopedia.com", "encykorea.aks.ac.kr", "terms.naver.com",
] as const;

export function sourceHost(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/\.$/, ""); } catch { return ""; }
}

export function isEncyclopediaHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  return ENCYCLOPEDIA_HOSTS.some((domain) => name === domain || name.endsWith(`.${domain}`));
}

// Text compared for copy grounding, after NFKC normalization and case folding. Upper then
// lower case maps characters such as the German sharp s to their folded form.
export function foldForMatch(text: string): string {
  return text.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC");
}

// True when a poster phrase is non-empty and appears in the transcribed poster text. Line
// breaks in a transcription are layout, so whitespace runs compare as one space.
export function posterPhraseGrounded(phrase: string, lines: readonly string[]): boolean {
  const squash = (text: string) => foldForMatch(text).replace(/\s+/g, " ").trim();
  const folded = squash(phrase);
  return folded.length > 0 && squash(lines.join(" ")).includes(folded);
}

// True when a finding's copy phrase is non-empty and appears in the submitted copy.
export function copyPhraseGrounded(phrase: string, copy: string): boolean {
  const folded = foldForMatch(phrase).trim();
  return folded.length > 0 && foldForMatch(copy).includes(folded);
}

const findingFields = {
  title: z.string().min(1).max(160),
  observedElement: prose,
  reportedClaim: prose,
  reportedInterpretation: prose,
  counterarguments: z.array(prose).max(6),
  modelInference: prose,
  sourceIds: z.array(z.string().min(1)).min(1).max(12),
  concernType: z.enum(CONCERN_TYPES),
  // The cited sources that document the public reaction or sensitivity itself.
  reactionSourceIds: z.array(z.string().min(1)).max(12),
  elements: z.array(z.enum(["copy", "image", "poster_text", "date"])).min(1).max(4),
  // For a date finding, the date or period a reaction source documents as sensitive, as
  // MM-DD for a recurring date or YYYY-MM-DD for one occasion. Empty strings otherwise.
  documentedDate: z.object({ start: z.string().max(10), end: z.string().max(10) }).strict(),
  reactionKind: z.enum(REACTION_KINDS),
  visualMatch: z.enum(VISUAL_MATCHES),
  // For a finding that relies on submitted copy, the exact phrase of that copy it relies on.
  // Empty otherwise.
  copyPhrase: z.string().max(COPY_PHRASE_MAX),
  // For a finding that relies on words printed in the poster, the exact words it relies on as
  // they appear in the transcribed poster text. Empty otherwise.
  posterPhrase: z.string().max(COPY_PHRASE_MAX),
};

// A short noun phrase naming the visible element a finding concerns, so SAM 3.1
// can locate it. The model writes an empty string when the finding is about copy
// or date only; the server stores that as null.
export const VISUAL_CONCEPT_MAX = 60;
export const findingSchema = z.object({
  ...findingFields,
  visualConcept: z.string().min(2).max(VISUAL_CONCEPT_MAX).nullable().default(null),
}).strict();
export const assessmentFindingSchema = z.object({
  ...findingFields,
  visualConcept: z.string().max(VISUAL_CONCEPT_MAX),
}).strict();

export const assessmentSchema = z.object({
  assessmentStatus: z.enum(["complete", "insufficient"]),
  insufficientReason: z.enum(INSUFFICIENT_REASONS),
  observations: z.array(observationSchema).max(12),
  findings: z.array(assessmentFindingSchema).max(8),
  evidenceScope: prose,
  limitations: z.array(prose).max(8),
}).strict();

// SAM 3.1 regions, in pixels of the image as the server measured it after EXIF orientation.
// A region marks where a named element appears. It never establishes meaning or risk.
const pixel = z.number().int().min(0).max(20_000);
export const regionSchema = z.object({
  id: z.string().regex(/^G[1-9][0-9]*$/),
  concept: z.string().min(2).max(VISUAL_CONCEPT_MAX),
  findingIndexes: z.array(z.number().int().min(0).max(7)).min(1).max(8),
  box: z.object({ left: pixel, top: pixel, right: pixel, bottom: pixel }).strict(),
  mask: z.object({
    path: z.string().min(1).max(150_000),
    x: pixel, y: pixel, scaleX: z.number().positive().max(50), scaleY: z.number().positive().max(50),
  }).strict().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  matchesForConcept: z.number().int().min(1).max(12),
}).strict();
export const conceptResultSchema = z.object({
  concept: z.string().min(2).max(VISUAL_CONCEPT_MAX),
  findingIndexes: z.array(z.number().int().min(0).max(7)).min(1).max(8),
  status: z.enum(["found", "not_found", "failed", "skipped"]),
  regionIds: z.array(z.string().regex(/^G[1-9][0-9]*$/)).max(12),
}).strict();
export const segmentationSchema = z.object({
  state: z.enum(["not_requested", "completed", "partial", "failed"]),
  reason: z.enum(["no_image", "no_visual_concepts"]).nullable(),
  model: z.literal("sam-3.1").nullable(),
  image: z.object({ width: z.number().int().positive().max(20_000), height: z.number().int().positive().max(20_000) }).strict().nullable(),
  concepts: z.array(conceptResultSchema).max(3),
  regions: z.array(regionSchema).max(24),
}).strict();
export type Segmentation = z.infer<typeof segmentationSchema>;
export type Region = z.infer<typeof regionSchema>;
export const notRequestedSegmentation = (reason: "no_image" | "no_visual_concepts"): Segmentation => ({
  state: "not_requested", reason, model: null, image: null, concepts: [], regions: [],
});

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

// Registry selection reads at most this many emerging and verified cases, selects at most
// MAX_SELECTED_CASES of them, and sends at most REGISTRY_CONTEXT_MAX characters of notes.
export const MAX_CANDIDATE_CASES = 50;
export const MAX_SELECTED_CASES = 3;
export const REGISTRY_CONTEXT_MAX = 60_000;
// Coverage gaps the registry check reports instead of dropping material silently. A case is
// always sent whole or left out whole, so a rebuttal never travels without its claim.
export const REGISTRY_GAPS = [
  "candidates_truncated", "case_graph_truncated", "selected_cases_truncated", "context_truncated",
  "imagery_candidates_truncated", "imagery_check_unavailable", "imagery_check_skipped",
] as const;
export const registryContextSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("available"), checkedCases: z.number().int().min(0).max(MAX_CANDIDATE_CASES),
    matchedCaseIds: z.array(z.uuid()).max(MAX_SELECTED_CASES), evidence: z.array(registryEvidenceSchema).max(60),
    gaps: z.array(z.enum(REGISTRY_GAPS)).max(REGISTRY_GAPS.length).default([]),
  }).strict(),
  z.object({
    state: z.literal("unavailable"), code: z.enum(["not_configured", "invalid_configuration", "database_unavailable", "bounded_context_exceeded"]),
  }).strict(),
]);

export type RegistryContext = z.infer<typeof registryContextSchema>;
export type RegistryContextInput = z.input<typeof registryContextSchema>;

// The only path to an evidence-backed concern. A surviving finding must cite a reported fact
// from a verified case that was available before the planned date. Model output cannot set it.
export function verifiedCaseSupport(findings: ReadonlyArray<{ sourceIds: readonly string[] }>, registry: RegistryContext, publicationDate: string): string[] {
  if (registry.state !== "available") return [];
  const cutoff = Date.parse(`${publicationDate}T00:00:00+09:00`);
  const notes = new Map(registry.evidence.map((note) => [note.id, note]));
  const cases = new Set<string>();
  for (const finding of findings) for (const id of finding.sourceIds) {
    const note = notes.get(id);
    if (note && note.caseStatus === "verified" && note.assertionKind === "reported_fact"
      && note.publishedOn < publicationDate && Date.parse(note.availableAt) < cutoff) cases.add(note.caseId);
  }
  return [...cases].sort();
}

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
  segmentation: segmentationSchema.default(notRequestedSegmentation("no_image")),
  // Signed by the server so a variant can be reassessed with this exact evidence.
  variantContext: z.string().max(900_000).nullable().default(null),
}).superRefine((result, context) => {
  const linked = [...result.segmentation.regions.flatMap((region) => region.findingIndexes), ...result.segmentation.concepts.flatMap((item) => item.findingIndexes)];
  if (linked.some((index) => index >= result.findings.length)) {
    context.addIssue({ code: "custom", message: "A region links to a finding that does not exist." });
  }
  const regionIds = new Set(result.segmentation.regions.map((region) => region.id));
  if (regionIds.size !== result.segmentation.regions.length || result.segmentation.concepts.some((item) => item.regionIds.some((id) => !regionIds.has(id)))) {
    context.addIssue({ code: "custom", message: "Region references must be unique and resolvable." });
  }
  const registryEvidence = result.registry.state === "available" ? result.registry.evidence : [];
  const sourceIds = [...result.sources.map((source) => source.id), ...registryEvidence.map((source) => source.id)];
  const ids = new Set(sourceIds);
  if (ids.size !== sourceIds.length || result.sources.some((source) => !/^S[1-9][0-9]*$/.test(source.id))) {
    context.addIssue({ code: "custom", message: "Source namespaces must be distinct and unique." });
  }
  if (result.findings.some((finding) => finding.sourceIds.some((id) => !ids.has(id)))) {
    context.addIssue({ code: "custom", message: "A finding references an unknown source." });
  }
  if (result.findings.some((finding) => !IN_SCOPE_CONCERNS.has(finding.concernType) || !finding.reactionSourceIds.length
    || finding.reactionSourceIds.some((id) => !finding.sourceIds.includes(id)) || !DOCUMENTED_REACTIONS.has(finding.reactionKind)
    || (finding.elements.includes("image") && finding.visualMatch !== "clear_visible_match"))) {
    context.addIssue({ code: "custom", message: "A finding must concern cultural, historical or social meaning, name a documented public reaction, and match any image element clearly." });
  }
  const urlOf = new Map<string, string>([...result.sources.map((source) => [source.id, source.annotation.url] as const),
    ...registryEvidence.map((source) => [source.id, source.canonicalUrl] as const)]);
  if (result.findings.some((finding) => finding.reactionSourceIds.length
    && finding.reactionSourceIds.every((id) => isEncyclopediaHost(sourceHost(urlOf.get(id) ?? ""))))) {
    context.addIssue({ code: "custom", message: "A reaction must be documented by a source other than an encyclopedia page." });
  }
  if (result.findings.some((finding) => finding.elements.includes("copy") && (!result.scope.hasCopy || !finding.copyPhrase.trim()))) {
    context.addIssue({ code: "custom", message: "A copy finding must name the submitted copy phrase it relies on." });
  }
  if (result.findings.some((finding) => finding.elements.includes("poster_text") && (!result.scope.hasImage || !finding.posterPhrase.trim()))) {
    context.addIssue({ code: "custom", message: "A poster wording finding must name the poster phrase it relies on." });
  }
  const supported = verifiedCaseSupport(result.findings, result.registry, result.scope.publicationDate);
  if (JSON.stringify([...result.verifiedCaseIds].sort()) !== JSON.stringify(supported)
    || (result.outcome === "evidence_backed_concern") !== (supported.length > 0)) {
    context.addIssue({ code: "custom", message: "Only the server's verified case check can make an evidence-backed concern." });
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
    "content_policy", "context_expired", "response_too_large",
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
  // width and height are measured by the server after EXIF orientation is applied.
  // uploadBytes is the size of the file as the browser sent it, which a variant request repeats.
  image?: { mediaType: typeof IMAGE_TYPES[number]; dataUrl: string; width?: number; height?: number; uploadBytes?: number };
};
