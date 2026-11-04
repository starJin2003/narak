import "server-only";
import { z } from "zod";
import { registryContextSchema, type RegistryContext, type ReviewInput } from "@/lib/review-contract";
import { createKnowledgeRepository } from "./repository";
import type { KnowledgeCaseDetail, KnowledgeRead } from "./types";

export const REVIEW_CASE_KEYS = [
  "starbucks-kr-tank-day-2026-05-18", "maplestory-angelic-buster-frame-2023-11", "gs25-camping-poster-2021-05",
];

// Only sources admitted by the supervised rights/provenance intake may be sent.
const permittedSources = new Set([
  "https://www.mt.co.kr/living/2026/05/18/2026051814054774713",
  "https://biz.chosun.com/distribution/channel/2026/05/26/C6WSJCO5NBHS5DY5KIS3DL36C4/",
  "https://www.inven.co.kr/webzine/news/?news=290842",
  "https://www.inews24.com/view/1660539",
  "https://www.edaily.co.kr/News/Read?mediaCodeNo=257&newsId=02148406629044984",
  "https://www.newspim.com/news/view/20210510000585",
]);

export const visualFeaturesSchema = z.array(z.enum([
  "animated_character", "thumb_index_near", "camping_scene", "hand_near_food", "moon_and_stars", "tumbler_on_desk",
])).max(6);
export type VisualFeatures = z.infer<typeof visualFeaturesSchema>;

export function observedFeatures(textBlocks: string[], imageProvided: boolean): VisualFeatures {
  if (!imageProvided) return [];
  // Optional neutral observations from the existing multimodal research call.
  // Malformed, missing or duplicated envelopes provide no visual matching basis.
  const matches = [...textBlocks.join("\n").matchAll(/<creative_observations>([^]*?)<\/creative_observations>/g)];
  if (matches.length !== 1 || matches[0]![1]!.length > 500) return [];
  try { return visualFeaturesSchema.parse(JSON.parse(matches[0]![1]!)); } catch { return []; }
}

type CandidateRead = () => Promise<KnowledgeRead<KnowledgeCaseDetail[]>>;
export type RegistryRetriever = (input: ReviewInput, features: VisualFeatures, signal: AbortSignal) => Promise<RegistryContext>;

function relevant(key: string, input: ReviewInput, features: VisualFeatures) {
  const copy = input.copy.normalize("NFKC").toLowerCase();
  const visual = (feature: VisualFeatures[number]) => Boolean(input.image) && features.includes(feature);
  if (key === REVIEW_CASE_KEYS[0]) {
    return /starbucks|\uc2a4\ud0c0\ubc85\uc2a4/.test(copy) &&
      /tank\s*day|\ud0f1\ud06c\s*\ub370\uc774/.test(copy) &&
      /tumbler|buddy\s*week|desk|\ud140\ube14\ub7ec|\ubc84\ub514|\ucc45\uc0c1/.test(copy) && input.publicationDate.slice(5) === "05-18";
  }
  if (key === REVIEW_CASE_KEYS[1]) {
    const production = /maple\s*story|\uba54\uc774\ud50c\uc2a4\ud1a0\ub9ac/.test(copy) && /angelic\s*buster|\uc5d4\uc824\ub9ad\s*\ubc84\uc2a4\ud130/.test(copy);
    return production && (/(?:hand|finger|gesture|frame|\uc190\uac00\ub77d|\uc190\ubaa8\uc591|\uc190\ub3d9\uc791|\ud504\ub808\uc784)/.test(copy) || (visual("animated_character") && visual("thumb_index_near")));
  }
  if (key === REVIEW_CASE_KEYS[2]) {
    return /\bgs\s*25\b|\uc9c0\uc5d0\uc2a4\s*25/.test(copy) && /camping|\ucea0\ud551/.test(copy) &&
      (/emotional\s+camping\s+must[- ]have\s+item/.test(copy) ||
        (/(poster|\ud3ec\uc2a4\ud130)/.test(copy) && /(hand|finger|moon|stars|\uc190\uac00\ub77d|\uc190\ubaa8\uc591|\ub2ec|\ubcc4)/.test(copy)) ||
        (visual("camping_scene") && visual("hand_near_food")));
  }
  return false;
}

export function selectRegistryContext(input: ReviewInput, features: VisualFeatures, candidates: KnowledgeRead<KnowledgeCaseDetail[]>, now = new Date()): RegistryContext {
  if (candidates.state === "unavailable") return candidates;
  if (candidates.data.length > 3) return { state: "unavailable", code: "bounded_context_exceeded" };
  const cutoff = Math.min(Date.parse(`${input.publicationDate}T00:00:00+09:00`), now.getTime());
  const context: Extract<RegistryContext, { state: "available" }> = { state: "available", checkedCases: candidates.data.length, matchedCaseIds: [], evidence: [] };
  for (const detail of candidates.data) {
    if (detail.evidence.length > 20 || detail.triggers.length > 12) return { state: "unavailable", code: "bounded_context_exceeded" };
    if (!relevant(detail.case.case_key, input, features)) continue;
    // Case summaries and trigger descriptions are retrospective and may disclose
    // later corrections. Only source-linked assertions enter the model context.
    let eligible = detail.evidence.filter((entry) =>
      ["reported_fact", "reported_interpretation", "rebuttal", "correction"].includes(entry.assertion_kind) &&
      entry.source.published_on !== null && entry.source.published_on < input.publicationDate &&
      Date.parse(`${entry.source.published_on}T00:00:00+09:00`) < cutoff &&
      Date.parse(entry.observed_at) < cutoff && permittedSources.has(entry.source.canonical_url),
    );
    const ids = new Set(eligible.map((entry) => entry.id));
    // A correction without its target would lose the meaning of the rebuttal.
    eligible = eligible.filter((entry) => !entry.related_evidence_id || ids.has(entry.related_evidence_id));
    if (!eligible.length) continue;
    const eligibleIds = new Set(eligible.map((entry) => entry.id));
    const supportedTriggers = detail.triggers.filter((entry) => eligibleIds.has(entry.evidence_id) &&
      (!entry.valid_from || entry.valid_from < input.publicationDate) && (!entry.valid_until || entry.valid_until >= input.publicationDate));
    if (!supportedTriggers.some((entry) => entry.trigger_kind === "copy")) continue;
    context.matchedCaseIds.push(detail.case.id);
    for (const entry of eligible) context.evidence.push({
      id: `R${context.evidence.length + 1}`, caseId: detail.case.id, caseStatus: detail.case.status as "emerging" | "verified",
      evidenceId: entry.id, sourceId: entry.source_id, canonicalUrl: entry.source.canonical_url,
      title: entry.source.title, publisher: entry.source.publisher, publishedOn: entry.source.published_on!, availableAt: entry.observed_at,
      assertionKind: entry.assertion_kind as "reported_fact" | "reported_interpretation" | "rebuttal" | "correction",
      assertionText: entry.assertion_text, attribution: entry.attribution, provenance: entry.source.provenance_note, relatedEvidenceId: entry.related_evidence_id,
    });
  }
  const parsed = registryContextSchema.safeParse(context);
  if (!parsed.success || JSON.stringify(context).length > 60_000) return { state: "unavailable", code: "bounded_context_exceeded" };
  return parsed.data;
}

export function createRegistryRetriever(read: CandidateRead = () => createKnowledgeRepository().getReviewCases(REVIEW_CASE_KEYS)): RegistryRetriever {
  return async (input, features, signal) => {
    signal.throwIfAborted();
    let onAbort: () => void = () => undefined;
    try {
      const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener("abort", onAbort, { once: true }); });
      // In-flight SQL still cleans up under the existing statement timeout and
      // read-only transaction. Cancellation never starts the assessment request.
      const candidates = await Promise.race([read(), aborted]);
      signal.throwIfAborted();
      return selectRegistryContext(input, features, candidates);
    } catch (error) {
      if (signal.aborted) throw error;
      return { state: "unavailable", code: "database_unavailable" };
    } finally { signal.removeEventListener("abort", onAbort); }
  };
}
