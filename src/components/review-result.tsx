"use client";

import type { ReactNode, Ref } from "react";
import Image from "next/image";
import type { ReviewResult } from "@/lib/review-contract";
import {
  BASIS_LABEL, BASIS_NOTE, OUTCOMES, citedPages, closeView, displayPassage, formatDate, formatMoment, hostname, locationDetail,
  locationLabel, mixedBasis, plural, retrospective, sourceCounts, sourceNames, textLang, unionBox, type CitedPage, type FindingView, type RegistryNote,
} from "@/lib/review-view";
import type { PosterImage } from "./poster-stage";

export function Chevron({ left = false }: { left?: boolean }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={left ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7"} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

export function StepNav({ index, total, onStep, label = "Move between findings", showCount = false, className = "" }: {
  index: number; total: number; onStep: (delta: number) => void; label?: string; showCount?: boolean; className?: string;
}) {
  if (total < 2) return null;
  return <div className={`nav ${className}`} role="group" aria-label={label}>
    <button className="iconbtn" type="button" aria-label="Previous finding" onClick={() => onStep(-1)}><Chevron left /></button>
    {showCount && <span className="count" aria-live="polite">{index + 1} of {total}</span>}
    <button className="iconbtn" type="button" aria-label="Next finding" onClick={() => onStep(1)}><Chevron /></button>
  </div>;
}

function BasisPill({ view }: { view: FindingView }) {
  return <span className={`pill ${view.basis === "verified_case" ? "concern" : "emerging"}`}>{BASIS_LABEL[view.basis]}</span>;
}

function segmentationSummary(result: ReviewResult): string {
  const { segmentation } = result;
  if (segmentation.state === "not_requested") {
    return segmentation.reason === "no_image" ? "No image, so nothing was outlined." : "No finding named a visible element, so nothing was outlined.";
  }
  const found = segmentation.concepts.filter((item) => item.status === "found").length;
  return `SAM 3.1 outlined ${found} of ${segmentation.concepts.length} named ${segmentation.concepts.length === 1 ? "element" : "elements"}.`;
}

// Left column of a completed review: the outcome once, the date, one summary, the findings
// and the ways on. Scope, observations and limits live in the evidence panel.
export function ResultSummary({ result, views, selected, onSelect, onEdit, onAllEvidence, onAnother, headingRef, retro }: {
  result: ReviewResult; views: FindingView[]; selected: number; onSelect: (index: number) => void;
  onEdit: () => void; onAllEvidence: () => void; onAnother: () => void; headingRef: Ref<HTMLHeadingElement>; retro: boolean;
}) {
  const outcome = OUTCOMES[result.outcome];
  const mixed = mixedBasis(views);
  return <>
    <div className="result-head">
      <span className={`glyph ${outcome.glyph}`} aria-hidden="true" />
      <h1 id="page-title" ref={headingRef} tabIndex={-1}>{outcome.label}</h1>
    </div>
    <p className="when">Runs {formatDate(result.scope.publicationDate, true)}{retro && <span className="pill none">Retrospective review</span>}</p>
    <p className="lede">{result.summary}</p>
    {views.length > 0 && <ol className="index" aria-label="Findings">
      {views.map((view) => <li key={view.index}>
        <button type="button" aria-current={view.index === selected} onClick={() => onSelect(view.index)}>
          <span className="n" aria-hidden="true">{view.number}</span>
          <span><b>{view.finding.title}</b>{mixed && <BasisPill view={view} />}
            {view.location.kind !== "found" && <small>{locationLabel(view.location)}</small>}</span>
        </button>
      </li>)}
    </ol>}
    <div className="links">
      <button className="textbtn" type="button" onClick={onAllEvidence}>Scope and all evidence</button>
      <button className="textbtn" type="button" onClick={onEdit}>{result.scope.hasImage ? "Edit poster or date" : "Edit copy or date"}</button>
    </div>
    <div><button className="btn quiet" type="button" onClick={onAnother}>Review another poster</button></div>
  </>;
}

export function FindingLens({ result, view, views, total, onStep, onEvidence, onVariant, lensRef, canVariant }: {
  result: ReviewResult; view: FindingView | undefined; views: FindingView[]; total: number; onStep: (delta: number) => void;
  onEvidence: () => void; onVariant?: () => void; lensRef: Ref<HTMLDivElement>; canVariant: boolean;
}) {
  if (!view) {
    const counts = sourceCounts(result);
    const registry = result.registry;
    return <div className="lens" ref={lensRef} role="region" aria-labelledby="lens-title">
      <h2 id="lens-title">What was checked</h2>
      <p>{`Muse Spark ran ${plural(result.scope.completedSearches, "search", "searches")} and cited ${plural(counts.webPages, "page")}. `}
        {registry.state === "available" ? `${plural(registry.checkedCases, "documented case")} ${registry.checkedCases === 1 ? "was" : "were"} checked, and ${registry.matchedCaseIds.length ? `${registry.matchedCaseIds.length} ${registry.matchedCaseIds.length === 1 ? "was" : "were"} selected for the assessment` : "none was selected for the assessment"}.` : "The documented cases could not be read."}</p>
      <div className="acts"><button className="btn quiet sm" type="button" onClick={onEvidence}>How it was checked</button></div>
    </div>;
  }
  return <div className="lens" ref={lensRef} role="region" aria-label={`Finding ${view.number} of ${total}`}>
    <div className="lens-top"><span className="fine">Finding {view.number} of {total}</span>{mixedBasis(views) && <BasisPill view={view} />}</div>
    <h2>{view.finding.title}</h2>
    <p>{view.finding.observedElement}</p>
    <p className="fine">{BASIS_NOTE[view.basis]} {locationDetail(view.location)}{view.sharedWith.length > 0 && ` The same element also appears in finding ${view.sharedWith.join(" and ")}.`}</p>
    <div className="acts">
      <button className="btn sm" type="button" onClick={onEvidence}>Evidence</button>
      {canVariant && onVariant && <button className="btn quiet sm" type="button" onClick={onVariant}>Test a variant</button>}
      <StepNav index={view.index} total={total} onStep={onStep} className="lens-nav" />
    </div>
  </div>;
}

// The close view: the poster cropped around the outlined area, with the prototype's ring
// placed on the real SAM 3.1 box.
function Crop({ image, view, size }: { image: PosterImage; view: FindingView; size: { width: number; height: number } }) {
  if (view.location.kind !== "found") return null;
  const regions = view.location.regions;
  const box = unionBox(regions);
  // The prototype crops 40 units around a region of an 800 by 1000 poster, so 4% of the long side.
  const area = closeView(box, size, 16 / 9, Math.round(Math.max(size.width, size.height) * 0.04));
  const pct = (value: number, total: number) => `${(value / total) * 100}%`;
  return <figure className="crop" style={{ aspectRatio: `${area.width} / ${area.height}` }}>
    <Image src={image.url} alt={`Close view of ${regions.length === 1 ? "the area" : `${regions.length} areas`} matching ${view.location.concept}`} unoptimized width={size.width} height={size.height}
      style={{ left: `-${pct(area.x, area.width)}`, top: `-${pct(area.y, area.height)}`, width: pct(size.width, area.width), height: pct(size.height, area.height) }} />
    {regions.map((region) => <span key={region.id} className="ring" aria-hidden="true" style={{
      left: pct(region.box.left - area.x, area.width), top: pct(region.box.top - area.y, area.height),
      width: pct(region.box.right - region.box.left, area.width), height: pct(region.box.bottom - region.box.top, area.height),
    }} />)}
    <figcaption>Outline by SAM 3.1</figcaption>
  </figure>;
}

const ASSERTION_LABEL = {
  reported_fact: "Reported fact", reported_interpretation: "Reported interpretation", rebuttal: "Rebuttal", correction: "Correction",
} as const;

// One attributed statement: who says it on the left, what they say on the right.
function Voice({ kind, who, text, attribution, against = false, lang }: {
  kind: string; who?: string; text: string; attribution?: string; against?: boolean; lang?: string;
}) {
  return <div className={`voice ${against ? "against" : ""}`}>
    <span className="k"><b>{kind}</b>{who}</span>
    <blockquote lang={lang ?? textLang(text)}>{text}</blockquote>
    {attribution && <p className="attr">{attribution}</p>}
  </div>;
}

function NoteVoice({ note, against = false }: { note: RegistryNote; against?: boolean }) {
  return <Voice kind={ASSERTION_LABEL[note.assertionKind]} who={note.publisher ?? hostname(note.canonicalUrl)} text={note.assertionText}
    attribution={`${note.attribution}, ${formatDate(note.publishedOn)}`} against={against} />;
}

// One cited page: its host and title once, then each passage the research cited from it.
// The exact provider text and the citation trace stay one step away.
function WebPage({ page }: { page: CitedPage }) {
  return <article className="src" aria-label={page.host}>
    <div className="src-top"><b>{page.host}</b><span>{plural(page.passages.length, "passage")}</span></div>
    {page.title && page.title !== page.host && <p className="src-title" lang={textLang(page.title)}>{page.title}</p>}
    <ul className="passages">
      {page.passages.map((source) => <li key={source.id}><blockquote lang={textLang(source.citedPassage)}>{displayPassage(source.citedPassage)}</blockquote></li>)}
    </ul>
    <a href={page.url} target="_blank" rel="noopener noreferrer">Open {page.host}<span className="vh"> (publisher page, opens in a new tab)</span></a>
    <details className="prov"><summary>Original text and citation trace</summary>
      <p>Each passage is research text that Muse Spark tied to this page. It is not a quotation from the page, and the page still needs a person to check it.</p>
      {page.passages.map((source, index) => <div className="trace" key={source.id}>
        {page.passages.length > 1 && <b>Passage {index + 1}</b>}
        <p className="raw" lang={textLang(source.citedPassage)}>{source.citedPassage}</p>
        <dl>
          <dt>Response</dt><dd>{source.responseId}</dd>
          <dt>Message and block</dt><dd>{source.messageId}, block {source.blockIndex}</dd>
          <dt>Character span</dt><dd>{source.annotation.start_index} to {source.annotation.end_index}</dd>
        </dl>
      </div>)}
    </details>
  </article>;
}

function WebPages({ pages }: { pages: CitedPage[] }) {
  if (!pages.length) return null;
  return <div className="src-group">
    <p className="group-label">Web pages cited by Muse Spark. No person has verified them.</p>
    {pages.map((page) => <WebPage key={page.url} page={page} />)}
  </div>;
}

// A documented case page in the registry and the notes taken from it.
function RegistryPage({ notes }: { notes: RegistryNote[] }) {
  const first = notes[0]!;
  return <article className="src" aria-label={first.publisher ?? hostname(first.canonicalUrl)}>
    <div className="src-top"><b>{first.publisher ?? hostname(first.canonicalUrl)}</b>
      <span>{formatDate(first.publishedOn)}</span></div>
    <p className="src-title" lang={textLang(first.title)}>{first.title}</p>
    <div className="row"><span className={`pill ${first.caseStatus === "verified" ? "concern" : "emerging"}`}>{first.caseStatus === "verified" ? "Verified case" : "Emerging case"}</span>
      <span className="fine">{plural(notes.length, "note")} from this page</span></div>
    <a href={first.canonicalUrl} target="_blank" rel="noopener noreferrer">Open {hostname(first.canonicalUrl)}<span className="vh"> (publisher page, opens in a new tab)</span></a>
    <details className="prov"><summary>Registry record</summary><dl>
      {notes.map((note) => <div key={note.id}>
        <dt>{ASSERTION_LABEL[note.assertionKind]}, available from</dt><dd>{formatMoment(note.availableAt)}</dd>
        <dt>{ASSERTION_LABEL[note.assertionKind]}, provenance</dt><dd>{note.provenance}</dd>
        <dt>{ASSERTION_LABEL[note.assertionKind]}, case and evidence record</dt><dd>{note.caseId}, {note.evidenceId}</dd>
      </div>)}
    </dl></details>
  </article>;
}

function CasePages({ notes }: { notes: RegistryNote[] }) {
  const groups = pages(notes);
  if (!groups.length) return null;
  return <div className="src-group">
    <p className="group-label">Documented case pages in the NARAK registry.</p>
    {groups.map((group) => <RegistryPage key={group[0]!.canonicalUrl} notes={group} />)}
  </div>;
}

function pages(notes: RegistryNote[]): RegistryNote[][] {
  const byUrl = new Map<string, RegistryNote[]>();
  for (const note of notes) byUrl.set(note.canonicalUrl, [...(byUrl.get(note.canonicalUrl) ?? []), note]);
  return [...byUrl.values()];
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="ev-sec" aria-label={title}><h3>{title}</h3>{children}</section>;
}

// The review as a whole: what the outcome means, what was checked and what it cannot show.
function Overview({ result, copy }: { result: ReviewResult; copy: string }) {
  const outcome = OUTCOMES[result.outcome];
  const scope = result.scope;
  const registry = result.registry;
  const counts = sourceCounts(result);
  const material = scope.hasImage ? (scope.hasCopy ? "Poster and copy" : "Poster") : "Copy";
  const notes = registry.state === "available" ? registry.evidence : [];
  return <>
    <div className="ev-title"><h2 id="ev-title" tabIndex={-1}>Scope and evidence</h2></div>
    <p className="ev-short">{outcome.note}</p>
    <Section title="What was checked">
      <dl className="facts">
        <dt>Runs on</dt><dd>{formatDate(scope.publicationDate, true)}</dd>
        <dt>Material</dt><dd>{material}</dd>
        <dt>Web searches</dt><dd>{scope.completedSearches.toLocaleString("en-US")}</dd>
        <dt>Cited web pages</dt><dd>{counts.webPages.toLocaleString("en-US")}{counts.webPassages !== counts.webPages && `, ${plural(counts.webPassages, "passage")}`}</dd>
        <dt>Documented cases</dt><dd>{registry.state === "available" ? `${registry.checkedCases.toLocaleString("en-US")} checked, ${registry.matchedCaseIds.length} selected for the assessment` : "Unavailable"}</dd>
        <dt>Outlines</dt><dd>{segmentationSummary(result)}</dd>
        <dt>Checked</dt><dd>{formatMoment(scope.checkedAt)}</dd>
      </dl>
      {retrospective(scope.publicationDate, scope.checkedAt) && <p className="fine retro-note">A past date makes this a retrospective review. Documented cases count only if they were reported before that day.</p>}
      <p className="fine scope-label">Scope, as the assessment states it</p>
      <p lang={textLang(scope.description)}>{scope.description}</p>
    </Section>
    {result.observations.length > 0 && <Section title="What Muse Spark saw in the creative">
      <ul>{result.observations.map((item, index) => <li key={index} lang={textLang(item.description)}>{item.description}</li>)}</ul>
      <p className="fine">These are model observations of the creative, not proof of intent.</p>
    </Section>}
    {scope.hasCopy && <Section title="Copy reviewed"><div className="copy-reviewed" lang={textLang(copy)} tabIndex={0} role="region" aria-label="Copy reviewed">{copy}</div></Section>}
    <Section title="Cited web pages">
      <p className="fine">{plural(counts.webPassages, "cited passage")} from {plural(counts.webPages, "page")} on {plural(counts.webSites, "site")}. One page can support several passages.</p>
      <WebPages pages={citedPages(result.sources)} />
    </Section>
    <Section title="Documented cases">
      {registry.state === "unavailable"
        ? <p>The case registry was unavailable for this review, so no documented case was checked.</p>
        : notes.length
          ? <>{notes.map((note) => <NoteVoice key={note.id} note={note} against={note.assertionKind === "rebuttal" || note.assertionKind === "correction"} />)}
            <CasePages notes={notes} /></>
          : <p>{registry.checkedCases ? `${plural(registry.checkedCases, "documented case")} ${registry.checkedCases === 1 ? "was" : "were"} considered, and none had notes eligible for this date.` : "No documented case matched this creative."}</p>}
    </Section>
    <Section title="What this review cannot establish"><ul>{result.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul></Section>
  </>;
}

// One finding opened into its record: what was reported, how it was read, what argues
// against it, the model's own inference, and the pages behind it.
function FindingRecord({ result, view, views, image, size }: {
  result: ReviewResult; view: FindingView; views: FindingView[]; image: PosterImage | null; size: { width: number; height: number } | null;
}) {
  const notes = view.registryNotes;
  const reported = notes.filter((note) => note.assertionKind === "reported_fact");
  const readings = notes.filter((note) => note.assertionKind === "reported_interpretation");
  const against = notes.filter((note) => note.assertionKind === "rebuttal" || note.assertionKind === "correction");
  const cited = sourceNames(view.finding.sourceIds, result);
  return <>
    {image && size && <Crop image={image} view={view} size={size} />}
    <div className="ev-title"><h2 id="ev-title" tabIndex={-1}>{view.finding.title}</h2>{mixedBasis(views) && <BasisPill view={view} />}</div>
    <p className="ev-short">{view.finding.observedElement}</p>
    <p className="fine ev-basis">{BASIS_NOTE[view.basis]}</p>
    <Section title="What was reported">
      <Voice kind="Muse Spark summary" who={cited} text={view.finding.reportedClaim} />
      {reported.map((note) => <NoteVoice key={note.id} note={note} />)}
    </Section>
    <Section title="How it has been read">
      <Voice kind="Muse Spark summary" who={cited} text={view.finding.reportedInterpretation} />
      {readings.map((note) => <NoteVoice key={note.id} note={note} />)}
    </Section>
    <Section title="Against this reading">
      {view.finding.counterarguments.map((item, index) => <Voice key={index} kind="Counterargument" who={cited} text={item} against />)}
      {against.map((note) => <NoteVoice key={note.id} note={note} against />)}
      {!view.finding.counterarguments.length && !against.length && <p>No counterargument was supplied. A person reviewing this finding needs to look for one.</p>}
    </Section>
    <Section title="Model inference">
      <Voice kind="Inference" who="Muse Spark" text={view.finding.modelInference} attribution="Written by Muse Spark about this creative. It is not a source." />
    </Section>
    <Section title="Sources">
      <WebPages pages={citedPages(view.webSources)} />
      <CasePages notes={notes} />
      {view.webSources.length + notes.length > 1 && <p className="fine">Sources that report the same case do not confirm each other independently.</p>}
    </Section>
  </>;
}

export function EvidencePanel({ open, result, view, views, image, size, copy, onClose, onStep, panelRef, body }: {
  open: boolean; result: ReviewResult | null; view: FindingView | null; views: FindingView[];
  image: PosterImage | null; size: { width: number; height: number } | null; copy: string;
  onClose: () => void; onStep: (delta: number) => void; panelRef: Ref<HTMLElement>; body?: ReactNode;
}) {
  return <aside className={`evidence ${open ? "open" : ""}`} ref={panelRef} aria-labelledby="ev-title" aria-hidden={!open} inert={!open} tabIndex={-1}>
    {result && <>
      <div className="ev-head">
        <button className="btn quiet sm" type="button" onClick={onClose}>Back to poster</button>
        {view && !body && <StepNav index={view.index} total={views.length} onStep={onStep} showCount />}
      </div>
      <div className="ev-body">
        {body ? body : view ? <FindingRecord result={result} view={view} views={views} image={image} size={size} /> : <Overview result={result} copy={copy} />}
      </div>
    </>}
  </aside>;
}
