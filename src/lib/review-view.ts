import type { Region, ReviewResult, ReviewSource } from "./review-contract";

export type RegistryNote = Extract<ReviewResult["registry"], { state: "available" }>["evidence"][number];
type Box = Region["box"];
type Size = { width: number; height: number };

// Where a finding sits on the poster. Only SAM 3.1 output places a finding; every
// other state says why no outline is shown, so the interface never draws a guess.
export type FindingLocation =
  | { kind: "no_image" }
  | { kind: "copy_or_date" }
  | { kind: "found"; concept: string; regions: Region[] }
  | { kind: "not_found" | "failed" | "skipped" | "not_located" | "unaligned"; concept: string };

export interface FindingView {
  index: number;
  number: number;
  finding: ReviewResult["findings"][number];
  location: FindingLocation;
  webSources: ReviewSource[];
  registryNotes: RegistryNote[];
  basis: "verified_case" | "emerging_case" | "web_research";
  sharedWith: number[];
}

export const OUTCOMES = {
  evidence_backed_concern: {
    label: "Evidence-backed concern", glyph: "g-concern",
    note: "A case that a person verified matches an element of this creative.",
  },
  emerging_signal: {
    label: "Emerging signal", glyph: "g-emerging",
    note: "Reported context looks relevant to this creative, and no person has verified it yet. A case verified by a person would make it an evidence-backed concern.",
  },
  no_supported_concern_found: {
    label: "No supported concern found", glyph: "g-clear",
    note: "Nothing in the cited research or the documented cases connected an element of this creative to a reported concern. This covers only what was checked.",
  },
} as const;

// The frame shows the browser's decoded image. Regions are drawn only when its shape
// matches the image SAM measured, so an outline can never drift off its element.
export function sameShape(a: Size | null, b: Size | null): boolean {
  if (!a || !b) return false;
  return Math.abs(a.width / a.height - b.width / b.height) <= 0.01;
}

export function buildFindingViews(result: ReviewResult, displayed: Size | null): FindingView[] {
  const segmentation = result.segmentation;
  const aligned = segmentation.image !== null && sameShape(segmentation.image, displayed);
  const notes = result.registry.state === "available" ? result.registry.evidence : [];
  return result.findings.map((finding, index) => {
    const webSources = result.sources.filter((source) => finding.sourceIds.includes(source.id));
    const registryNotes = notes.filter((note) => finding.sourceIds.includes(note.id));
    const concept = segmentation.concepts.find((item) => item.findingIndexes.includes(index));
    let location: FindingLocation;
    if (!result.scope.hasImage) location = { kind: "no_image" };
    else if (!finding.visualConcept) location = { kind: "copy_or_date" };
    else if (!concept) location = { kind: "not_located", concept: finding.visualConcept };
    else if (concept.status === "found") {
      const regions = segmentation.regions.filter((region) => concept.regionIds.includes(region.id));
      location = !regions.length ? { kind: "not_found", concept: concept.concept }
        : aligned ? { kind: "found", concept: concept.concept, regions } : { kind: "unaligned", concept: concept.concept };
    } else location = { kind: concept.status, concept: concept.concept };
    // The same rule the server uses for the outcome: a cited reported fact from a verified case
    // that the server confirmed. Anything else stays an emerging signal.
    const basis = registryNotes.some((note) => note.caseStatus === "verified" && note.assertionKind === "reported_fact" && result.verifiedCaseIds.includes(note.caseId))
      ? "verified_case" : registryNotes.length ? "emerging_case" : "web_research";
    const sharedWith = concept ? concept.findingIndexes.filter((other) => other !== index).map((other) => other + 1) : [];
    return { index, number: index + 1, finding, location, webSources, registryNotes, basis, sharedWith };
  });
}

export const BASIS_LABEL = {
  verified_case: "Evidence-backed concern", emerging_case: "Emerging signal", web_research: "Emerging signal",
} as const;
export const BASIS_NOTE = {
  verified_case: "Backed by a reported fact from a documented case that a person verified.",
  emerging_case: "Backed by a documented case that no person has verified yet.",
  web_research: "Backed by cited web sources only. No documented case was cited.",
} as const;

// A planned date before the day of the check makes a retrospective review.
export function retrospective(publicationDate: string, checkedAt: string): boolean {
  const checked = new Date(checkedAt);
  if (!Number.isFinite(checked.getTime())) return false;
  // The market is South Korea, so the day of the check is its Seoul date.
  const seoul = new Date(checked.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
  return publicationDate < seoul;
}

// Readable names for the source trail, so internal S and R identifiers never reach the page.
export function sourceNames(ids: readonly string[], result: ReviewResult): string {
  const notes = result.registry.state === "available" ? result.registry.evidence : [];
  const names = ids.map((id) => {
    const web = result.sources.find((source) => source.id === id);
    if (web) return hostname(web.annotation.url);
    const note = notes.find((entry) => entry.id === id);
    return note ? note.publisher ?? hostname(note.canonicalUrl) : null;
  }).filter((name): name is string => Boolean(name));
  return [...new Set(names)].join(", ");
}

export function locationLabel(location: FindingLocation): string {
  switch (location.kind) {
    case "no_image": return "Copy review";
    case "copy_or_date": return "About the copy or date";
    case "found": return location.regions.length === 1 ? "Outlined on the poster" : `${location.regions.length} matching areas outlined`;
    case "not_found": return "No matching area found";
    case "failed": return "Outline unavailable";
    case "skipped": return "Outline skipped";
    case "not_located": return "Not outlined";
    case "unaligned": return "Outline unavailable";
  }
}

export function locationDetail(location: FindingLocation): string {
  switch (location.kind) {
    case "no_image": return "This review checked copy and date only.";
    case "copy_or_date": return "The assessment ties this finding to the copy or the date, so nothing on the poster is outlined.";
    case "found": return location.regions.length === 1
      ? `SAM 3.1 outlined one area matching "${location.concept}". The outline shows position only.`
      : `SAM 3.1 outlined ${location.regions.length} areas matching "${location.concept}". The assessment does not say which one it concerns, so all of them are shown.`;
    case "not_found": return `SAM 3.1 found no area matching "${location.concept}". The finding still stands on its sources.`;
    case "failed": return `The outline request for "${location.concept}" failed. The finding still stands on its sources.`;
    case "skipped": return `The review ran out of time before outlining "${location.concept}". The finding still stands on its sources.`;
    case "not_located": return `This review outlines up to three named elements, and "${location.concept}" was beyond that limit.`;
    case "unaligned": return "The displayed image did not match the size SAM 3.1 measured, so outlines are hidden for this review.";
  }
}

export function unionBox(regions: ReadonlyArray<{ box: Box }>): Box {
  return regions.reduce((all, { box }) => ({
    left: Math.min(all.left, box.left), top: Math.min(all.top, box.top),
    right: Math.max(all.right, box.right), bottom: Math.max(all.bottom, box.bottom),
  }), { ...regions[0]!.box });
}

export function percentBox(box: Box, image: Size) {
  return {
    left: `${(box.left / image.width) * 100}%`, top: `${(box.top / image.height) * 100}%`,
    width: `${((box.right - box.left) / image.width) * 100}%`, height: `${((box.bottom - box.top) / image.height) * 100}%`,
  };
}

// A close view around the regions, widened toward a landscape shape and kept inside the image.
// The evidence panel passes a fixed margin, as the prototype's crop does.
export function closeView(box: Box, image: Size, ratio = 1.4, margin?: number) {
  const pad = margin ?? Math.round(Math.max(box.right - box.left, box.bottom - box.top) * 0.35) + 12;
  let width = box.right - box.left + pad * 2;
  let height = box.bottom - box.top + pad * 2;
  if (width / height < ratio) width = height * ratio; else height = width / ratio;
  width = Math.min(width, image.width); height = Math.min(height, image.height);
  const cx = (box.left + box.right) / 2, cy = (box.top + box.bottom) / 2;
  const x = Math.min(Math.max(0, cx - width / 2), image.width - width);
  const y = Math.min(Math.max(0, cy - height / 2), image.height - height);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

export function maskTransform(mask: NonNullable<Region["mask"]>): string {
  return `translate(${mask.x} ${mask.y}) scale(${mask.scaleX} ${mask.scaleY})`;
}

export function hostname(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

// Dates read as the prototype writes them, "8 May 2027", and a run date adds the weekday.
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function formatDate(value: string, weekday = false): string {
  const date = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime())) return value;
  const text = `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
  return weekday ? `${DAYS[date.getUTCDay()]} ${text}` : text;
}

// Citations, pages and publishers are different counts. One page can back several cited
// passages, and the registry stores its own notes linked to canonical pages.
export function sourceCounts(result: ReviewResult) {
  const webUrls = new Set(result.sources.map((source) => source.annotation.url));
  const notes = result.registry.state === "available" ? result.registry.evidence : [];
  return {
    webPassages: result.sources.length,
    webPages: webUrls.size,
    webSites: new Set([...webUrls].map(hostname)).size,
    registryNotes: notes.length,
    registryPages: new Set(notes.map((note) => note.canonicalUrl)).size,
  };
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

// Copy and instructions can be Korean or English. Hangul marks the text as Korean so a
// screen reader picks a Korean voice; other text keeps the page language.
export function textLang(value: string): "ko" | undefined {
  return /[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7af\ud7b0-\ud7ff]/.test(value) ? "ko" : undefined;
}

// Research text can start a cited span with Markdown list or quote markers, inline emphasis,
// or in the middle of a sentence after a comma. Only the display changes: markers and
// emphasis go, leftover leading punctuation goes, and an ellipsis marks a passage that starts
// mid sentence. No word is added. The stored passage and its character span stay exact.
const ELLIPSIS = "\u2026";
export function displayPassage(value: string): string {
  const lines = value.split("\n").map((line) => line
    .replace(/^\s*(?:(?:[>*\u2022-]|\d+[.)])\s+)+/, "")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/[ \t]+/g, " ")
    .trim()).filter((line, index, all) => line || (index > 0 && index < all.length - 1));
  let text = lines.join("\n").trim();
  if (!text) return text;
  // A digit after the mark means it belongs to a number, such as "-5" or ".5", so it stays.
  const lead = /^(?:\s|[,;:)\]\u3001\u3002\uff0c](?!\d)|[.\u2013\u2014-](?=\s))+/.exec(text);
  if (lead) text = text.slice(lead[0].length).trimStart();
  if (!text) return value.trim();
  // A lowercase start reads as mid sentence, except in names such as iPhone or eBay.
  const midStart = Boolean(lead) || /^\p{Ll}(?!\p{Lu})/u.test(text);
  return `${midStart ? ELLIPSIS : ""}${text}`;
}

// Cited passages grouped under the page they cite, in first citation order. The page's
// host and title show once, above its passages.
export interface CitedPage { url: string; host: string; title: string; passages: ReviewSource[] }
export function citedPages(sources: readonly ReviewSource[]): CitedPage[] {
  const pages = new Map<string, CitedPage>();
  for (const source of sources) {
    const url = source.annotation.url;
    const page = pages.get(url) ?? { url, host: hostname(url), title: source.annotation.title.trim(), passages: [] };
    if (!page.title && source.annotation.title.trim()) page.title = source.annotation.title.trim();
    page.passages.push(source);
    pages.set(url, page);
  }
  return [...pages.values()];
}

// A finding's basis label is shown only when findings differ, so it never repeats the
// outcome the heading already states.
export function mixedBasis(views: readonly FindingView[]): boolean {
  return new Set(views.map((view) => BASIS_LABEL[view.basis])).size > 1;
}

// A moment in Seoul time, the market's own clock, in the page's date style.
export function formatMoment(value: string): string {
  const moment = new Date(value);
  if (!Number.isFinite(moment.getTime())) return value;
  const seoul = new Date(moment.getTime() + 9 * 3_600_000);
  const day = formatDate(seoul.toISOString().slice(0, 10));
  return `${day}, ${String(seoul.getUTCHours()).padStart(2, "0")}:${String(seoul.getUTCMinutes()).padStart(2, "0")} Seoul time`;
}
