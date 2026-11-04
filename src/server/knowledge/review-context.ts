import "server-only";
import {
  foldForMatch, MAX_SELECTED_CASES, REGISTRY_CONTEXT_MAX, registryContextSchema,
  type REGISTRY_GAPS, type RegistryContext, type RegistryContextInput, type ReviewInput,
} from "@/lib/review-contract";
import { createKnowledgeRepository } from "./repository";
import type { CaseEvidence, CaseTrigger, KnowledgeCaseDetail, KnowledgeRead, ReviewCandidates } from "./types";

// Registry selection is data driven. Every emerging or verified case in a bounded read is a
// candidate. Its copy triggers are matched against the submitted copy and the transcribed
// poster text, its date triggers against the planned date, and its imagery triggers by one
// low effort Muse Spark check of the poster. Selection is a relevance hypothesis only. The
// assessment still decides whether the documented case bears on the creative.

type Gap = typeof REGISTRY_GAPS[number];
export type MatchKind = "copy" | "poster_text" | "publication_date" | "imagery";
export const MAX_IMAGERY_CASES = 12;
const MIN_PHRASE = 3;

export type ImageryCandidate = { caseId: string; cues: string[] };
export type ImageryCheck = { state: "checked"; caseIds: string[] } | { state: "failed" } | { state: "skipped" };
export type ImageryMatcher = (candidates: ImageryCandidate[], signal: AbortSignal) => Promise<ImageryCheck>;
export type SelectionSummary = {
  candidates: number; eligible: number; selected: number;
  byKind: Record<MatchKind, number>; imagery: ImageryCheck["state"] | "not_needed"; gaps: Gap[];
};
export type RegistryRetriever = (input: ReviewInput, visibleText: string[], signal: AbortSignal,
  matchImagery?: ImageryMatcher, report?: (summary: SelectionSummary) => void) => Promise<RegistryContextInput>;

type EligibleCase = { detail: KnowledgeCaseDetail; evidence: CaseEvidence[]; triggers: CaseTrigger[] };

const squash = (text: string) => foldForMatch(text).replace(/\s+/g, " ").trim();

// The existing temporal rules. Notes need a source published before the planned day and must
// have been known before both that day and now. Model inference never enters the context.
// A trigger counts only from its valid_from date and only when it rests on an eligible note.
export function eligibleCases(input: ReviewInput, candidates: ReviewCandidates, now = new Date()): { eligible: EligibleCase[]; gaps: Set<Gap> } {
  const gaps = new Set<Gap>();
  if (candidates.truncated) gaps.add("candidates_truncated");
  const cutoff = Math.min(Date.parse(`${input.publicationDate}T00:00:00+09:00`), now.getTime());
  const eligible: EligibleCase[] = [];
  for (const detail of candidates.cases) {
    if (detail.case.status !== "emerging" && detail.case.status !== "verified") continue;
    let evidence = detail.evidence.filter((entry) =>
      ["reported_fact", "reported_interpretation", "rebuttal", "correction"].includes(entry.assertion_kind) &&
      entry.source.published_on !== null && entry.source.published_on < input.publicationDate &&
      Date.parse(`${entry.source.published_on}T00:00:00+09:00`) < cutoff && Date.parse(entry.observed_at) < cutoff);
    const ids = new Set(evidence.map((entry) => entry.id));
    // A correction without its target would lose the meaning of the rebuttal.
    evidence = evidence.filter((entry) => !entry.related_evidence_id || ids.has(entry.related_evidence_id));
    const kept = new Set(evidence.map((entry) => entry.id));
    const triggers = detail.triggers.filter((entry) => kept.has(entry.evidence_id) &&
      (!entry.valid_from || entry.valid_from < input.publicationDate) && (!entry.valid_until || entry.valid_until >= input.publicationDate));
    if (!evidence.length || !triggers.length) continue;
    // A graph larger than one review carries is left out whole, never cut short.
    if (!detail.complete) { gaps.add("case_graph_truncated"); continue; }
    eligible.push({ detail, evidence, triggers });
  }
  return { eligible, gaps };
}

// Copy triggers list alternatives separated by semicolons. Each alternative matches when it
// appears in the copy or the poster text after NFKC normalization, case folding and spacing.
export function phrases(matchText: string | null): string[] {
  return (matchText ?? "").split(";").map(squash).filter((phrase) => phrase.length >= MIN_PHRASE);
}

export function textMatches(input: ReviewInput, visibleText: readonly string[], eligible: EligibleCase[]): Map<string, Set<MatchKind>> {
  const copy = squash(input.copy), poster = input.image ? squash(visibleText.join(" ")) : "";
  const matches = new Map<string, Set<MatchKind>>();
  for (const { detail, triggers } of eligible) {
    const kinds = new Set<MatchKind>();
    for (const trigger of triggers) {
      if (trigger.trigger_kind === "copy") for (const phrase of phrases(trigger.match_text)) {
        if (copy.includes(phrase)) kinds.add("copy");
        if (poster.includes(phrase)) kinds.add("poster_text");
      }
      if (trigger.trigger_kind === "publication_date" && trigger.publication_start_date && trigger.publication_end_date
        && trigger.publication_start_date <= input.publicationDate && input.publicationDate <= trigger.publication_end_date) kinds.add("publication_date");
    }
    if (kinds.size) matches.set(detail.case.id, kinds);
  }
  return matches;
}

// Imagery cues for the cases not already selected. Only trigger match text goes to the model,
// never a case summary, trigger description or note, which can carry later knowledge.
export function imageryCandidates(eligible: EligibleCase[], selected: Set<string>): { candidates: ImageryCandidate[]; truncated: boolean } {
  const all = eligible.filter(({ detail }) => !selected.has(detail.case.id)).map(({ detail, triggers }) => ({
    caseId: detail.case.id,
    cues: triggers.filter((trigger) => trigger.trigger_kind === "imagery" && trigger.match_text).map((trigger) => trigger.match_text!.trim().slice(0, 300)),
  })).filter((item) => item.cues.length > 0);
  return { candidates: all.slice(0, MAX_IMAGERY_CASES), truncated: all.length > MAX_IMAGERY_CASES };
}

const toNote = (detail: KnowledgeCaseDetail, entry: CaseEvidence, id: string) => ({
  id, caseId: detail.case.id, caseStatus: detail.case.status as "emerging" | "verified",
  evidenceId: entry.id, sourceId: entry.source_id, canonicalUrl: entry.source.canonical_url,
  title: entry.source.title, publisher: entry.source.publisher, publishedOn: entry.source.published_on!, availableAt: entry.observed_at,
  assertionKind: entry.assertion_kind as "reported_fact" | "reported_interpretation" | "rebuttal" | "correction",
  assertionText: entry.assertion_text, attribution: entry.attribution, provenance: entry.source.provenance_note, relatedEvidenceId: entry.related_evidence_id,
});

// Verified cases first, then cases matched in more ways, then the read order (most recently
// seen). Each case is sent whole with every eligible note, or not at all.
export function buildRegistryContext(eligible: EligibleCase[], matches: Map<string, Set<MatchKind>>, gaps: Set<Gap>, checkedCases: number): RegistryContext {
  const order = new Map(eligible.map(({ detail }, index) => [detail.case.id, index]));
  const chosen = eligible.filter(({ detail }) => matches.has(detail.case.id)).sort((a, b) =>
    Number(b.detail.case.status === "verified") - Number(a.detail.case.status === "verified")
    || matches.get(b.detail.case.id)!.size - matches.get(a.detail.case.id)!.size
    || order.get(a.detail.case.id)! - order.get(b.detail.case.id)!);
  if (chosen.length > MAX_SELECTED_CASES) gaps.add("selected_cases_truncated");
  const context: Extract<RegistryContext, { state: "available" }> = { state: "available", checkedCases, matchedCaseIds: [], evidence: [], gaps: [] };
  for (const { detail, evidence } of chosen.slice(0, MAX_SELECTED_CASES)) {
    const notes = evidence.map((entry, index) => toNote(detail, entry, `R${context.evidence.length + index + 1}`));
    const trial = { ...context, matchedCaseIds: [...context.matchedCaseIds, detail.case.id], evidence: [...context.evidence, ...notes] };
    if (trial.evidence.length > 60 || JSON.stringify(trial).length > REGISTRY_CONTEXT_MAX) { gaps.add("context_truncated"); continue; }
    context.matchedCaseIds = trial.matchedCaseIds; context.evidence = trial.evidence;
  }
  context.gaps = [...gaps].sort();
  const parsed = registryContextSchema.safeParse(context);
  return parsed.success ? parsed.data : { state: "unavailable", code: "bounded_context_exceeded" };
}

type CandidateRead = () => Promise<KnowledgeRead<ReviewCandidates>>;

export function createRegistryRetriever(read: CandidateRead = () => createKnowledgeRepository().getReviewCandidates()): RegistryRetriever {
  return async (input, visibleText, signal, matchImagery, report) => {
    signal.throwIfAborted();
    let onAbort: () => void = () => undefined;
    try {
      const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener("abort", onAbort, { once: true }); });
      // In-flight SQL still cleans up under the existing statement timeout and read-only
      // transaction. Cancellation never starts the assessment request.
      const candidates = await Promise.race([read(), aborted]);
      signal.throwIfAborted();
      if (candidates.state === "unavailable") return candidates;
      const { eligible, gaps } = eligibleCases(input, candidates.data);
      const matches = textMatches(input, visibleText, eligible);
      let imagery: SelectionSummary["imagery"] = "not_needed";
      if (input.image) {
        const pending = imageryCandidates(eligible, new Set(matches.keys()));
        if (pending.truncated) gaps.add("imagery_candidates_truncated");
        if (pending.candidates.length) {
          // An imagery failure is a coverage gap. It never makes the registry unavailable.
          let check: ImageryCheck = { state: "failed" };
          if (matchImagery) {
            try { check = await Promise.race([matchImagery(pending.candidates, signal), aborted]); }
            catch (error) { if (signal.aborted) throw error; check = { state: "failed" }; }
          }
          signal.throwIfAborted();
          imagery = check.state;
          if (check.state === "failed") gaps.add("imagery_check_unavailable");
          if (check.state === "skipped") gaps.add("imagery_check_skipped");
          if (check.state === "checked") {
            const allowed = new Set(pending.candidates.map((item) => item.caseId));
            for (const id of check.caseIds) if (allowed.has(id)) matches.set(id, new Set([...(matches.get(id) ?? []), "imagery"]));
          }
        }
      }
      const context = buildRegistryContext(eligible, matches, gaps, candidates.data.cases.length);
      const byKind: Record<MatchKind, number> = { copy: 0, poster_text: 0, publication_date: 0, imagery: 0 };
      for (const kinds of matches.values()) for (const kind of kinds) byKind[kind] += 1;
      report?.({ candidates: candidates.data.cases.length, eligible: eligible.length, selected: context.state === "available" ? context.matchedCaseIds.length : 0,
        byKind, imagery, gaps: context.state === "available" ? context.gaps : [] });
      return context;
    } catch (error) {
      if (signal.aborted) throw error;
      return { state: "unavailable", code: "database_unavailable" };
    } finally { signal.removeEventListener("abort", onAbort); }
  };
}
