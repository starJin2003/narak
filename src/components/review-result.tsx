"use client";

import type { ReactNode, Ref } from "react";
import Image from "next/image";
import type { ReviewResult, ReviewSource } from "@/lib/review-contract";
import {
  BASIS_LABEL, BASIS_NOTE, OUTCOMES, closeView, formatDate, hostname, locationDetail, locationLabel,
  displayPassage, plural, retrospective, sourceCounts, sourceNames, textLang, unionBox, type FindingView, type RegistryNote,
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

// Left column of a completed review. The outcome, then what it rests on.
export function ResultSummary({ result, views, selected, onSelect, onEdit, onAllEvidence, headingRef }: {
  result: ReviewResult; views: FindingView[]; selected: number; onSelect: (index: number) => void;
  onEdit: () => void; onAllEvidence: () => void; headingRef: Ref<HTMLHeadingElement>;
}) {
  const outcome = OUTCOMES[result.outcome];
  const registry = result.registry;
  const scope = result.scope;
  const counts = sourceCounts(result);
  const material = scope.hasImage ? (scope.hasCopy ? "Poster and copy" : "Poster") : "Copy";
  return <>
    <div className="result-head">
      <span className={`glyph ${outcome.glyph}`} aria-hidden="true" />
      <h1 id="page-title" ref={headingRef} tabIndex={-1}>{outcome.label}</h1>
      <button className="chip date-m" type="button" onClick={onEdit} aria-label={`Runs ${formatDate(scope.publicationDate, true)}. Edit the creative or date`}>{formatDate(scope.publicationDate)}</button>
    </div>
    <p className="lede">{result.summary}</p>
    {retrospective(scope.publicationDate, scope.checkedAt) && <div className="retro">
      <span className="pill none">Retrospective review</span>
      <p className="fine">A past date makes this a retrospective review. Documented cases count only if they were reported before that day.</p>
    </div>}
    <details className="about">
      <summary>About this outcome</summary>
      <div className="about-body">
        <p>{outcome.note}</p>
        <dl>
          <dt>Runs on</dt><dd><b>{formatDate(scope.publicationDate, true)}</b></dd>
          <dt>Material</dt><dd><b>{material}</b></dd>
          <dt>Cited web pages</dt><dd><b>{counts.webPages}</b>{counts.webPassages !== counts.webPages && ` from ${plural(counts.webPassages, "cited passage")}`}</dd>
          <dt>Completed searches</dt><dd><b>{scope.completedSearches}</b></dd>
          <dt>Documented cases</dt><dd><b>{registry.state === "available" ? `${registry.matchedCaseIds.length} matched` : "Registry unavailable"}</b>
            {counts.registryNotes > 0 && `, ${plural(counts.registryNotes, "note")} from ${plural(counts.registryPages, "page")}`}</dd>
        </dl>
        <p>{scope.description}</p>
        <p>{segmentationSummary(result)}</p>
        {result.observations.length > 0 && <>
          <b>Observed in the creative</b>
          <ul>{result.observations.map((item, index) => <li key={index}>{item.description}</li>)}</ul>
        </>}
        <b>What this review cannot establish</b>
        <ul>{result.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul>
        <p className="fine">Checked {new Date(scope.checkedAt).toLocaleString("en-US", { timeZoneName: "short" })}.</p>
      </div>
    </details>
    {views.length > 0 && <ol className="index" aria-label="Findings">
      {views.map((view) => <li key={view.index}>
        <button type="button" aria-current={view.index === selected} onClick={() => onSelect(view.index)}>
          <span className="n" aria-hidden="true">{view.number}</span>
          <span><b>{view.finding.title}</b><BasisPill view={view} />
            {view.location.kind !== "found" && <small>{locationLabel(view.location)}</small>}</span>
        </button>
      </li>)}
    </ol>}
    <div className="row"><button className="textbtn" type="button" onClick={onAllEvidence}>All evidence</button></div>
  </>;
}

export function FindingLens({ result, view, total, onStep, onEvidence, onVariant, lensRef, canVariant }: {
  result: ReviewResult; view: FindingView | undefined; total: number; onStep: (delta: number) => void;
  onEvidence: () => void; onVariant?: () => void; lensRef: Ref<HTMLDivElement>; canVariant: boolean;
}) {
  if (!view) {
    return <div className="lens" ref={lensRef} role="region" aria-label="What was checked">
      <div className="lens-top"><span className="fine">What was checked</span><span className="pill none">{plural(sourceCounts(result).webPages, "cited page")}</span></div>
      <h2>{OUTCOMES[result.outcome].label}</h2>
      <p>{result.scope.description}</p>
      <div className="acts"><button className="btn quiet sm" type="button" onClick={onEvidence}>How it was checked</button></div>
    </div>;
  }
  return <div className="lens" ref={lensRef} role="region" aria-label={`Finding ${view.number} of ${total}`}>
    <div className="lens-top"><span className="fine">Finding {view.number} of {total}</span><BasisPill view={view} /></div>
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
  kind: string; who: string; text: string; attribution?: string; against?: boolean; lang?: string;
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

function WebSource({ source }: { source: ReviewSource }) {
  return <div className="src" id={`source-${source.id}`}>
    <div className="src-top"><b>{hostname(source.annotation.url)}</b><span>Unverified web citation</span></div>
    <span className="fine">{source.annotation.title || hostname(source.annotation.url)}</span>
    <p className="passage">{displayPassage(source.citedPassage)}</p>
    <a href={source.annotation.url} target="_blank" rel="noopener noreferrer">{hostname(source.annotation.url)}<span className="vh"> (publisher page, opens in a new tab)</span></a>
    <details className="prov"><summary>Citation trace</summary>
      <p>This passage is the research text the citation supports. It is not a quotation from the page, and the page still needs a person to check it.</p>
      <dl>
        <dt>Response</dt><dd>{source.responseId}</dd>
        <dt>Message and block</dt><dd>{source.messageId}, block {source.blockIndex}</dd>
        <dt>Character span</dt><dd>{source.annotation.start_index} to {source.annotation.end_index}</dd>
      </dl>
    </details>
  </div>;
}

// A documented case page and the registry notes taken from it.
function RegistryPage({ notes }: { notes: RegistryNote[] }) {
  const first = notes[0]!;
  return <div className="src">
    <div className="src-top"><b>{first.publisher ?? hostname(first.canonicalUrl)}</b>
      <span>{formatDate(first.publishedOn)}, {plural(notes.length, "note")}</span></div>
    <span className="fine">{first.title}</span>
    <div className="row"><span className={`pill ${first.caseStatus === "verified" ? "concern" : "emerging"}`}>{first.caseStatus === "verified" ? "Verified case" : "Emerging case"}</span></div>
    <a href={first.canonicalUrl} target="_blank" rel="noopener noreferrer">{hostname(first.canonicalUrl)}<span className="vh"> (publisher page, opens in a new tab)</span></a>
    <details className="prov"><summary>Registry record</summary><dl>
      {notes.map((note) => <div key={note.id}>
        <dt>{ASSERTION_LABEL[note.assertionKind]}, case and evidence</dt><dd>{note.caseId}, {note.evidenceId}</dd>
        <dt>{ASSERTION_LABEL[note.assertionKind]}, available from</dt><dd>{note.availableAt}</dd>
        <dt>{ASSERTION_LABEL[note.assertionKind]}, provenance</dt><dd>{note.provenance}</dd>
      </div>)}
    </dl></details>
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

// How this finding was found, from the result itself. Nothing here is a planned feature.
function HowFound({ result, view }: { result: ReviewResult; view: FindingView }) {
  const counts = sourceCounts(result);
  const registry = result.registry;
  return <div className="how">
    <div><b>Cited web research</b><span className="pill built">Ran</span>
      <p>Muse Spark ran {plural(result.scope.completedSearches, "completed search", "completed searches")} and cited {plural(counts.webPages, "page")}.</p></div>
    <div><b>Documented cases</b>{registry.state === "available" ? <span className="pill built">Ran</span> : <span className="pill none">Unavailable</span>}
      <p>{registry.state === "available" ? `NARAK read ${plural(registry.checkedCases, "candidate case")} from its registry and ${registry.matchedCaseIds.length ? `matched ${registry.matchedCaseIds.length}` : "matched none"}.` : "The registry could not be read for this review."}</p></div>
    {view.location.kind !== "no_image" && <div><b>Region outline</b>{view.location.kind === "found" ? <span className="pill built">Ran</span> : <span className="pill none">Not outlined</span>}
      <p>{locationDetail(view.location)}</p></div>}
  </div>;
}

export function EvidencePanel({ open, result, view, views, image, size, copy, onClose, onStep, panelRef, body }: {
  open: boolean; result: ReviewResult | null; view: FindingView | null; views: FindingView[];
  image: PosterImage | null; size: { width: number; height: number } | null; copy: string;
  onClose: () => void; onStep: (delta: number) => void; panelRef: Ref<HTMLElement>; body?: ReactNode;
}) {
  const registry = result?.registry.state === "available" ? result.registry.evidence : [];
  const counts = result ? sourceCounts(result) : null;
  const notes = view?.registryNotes ?? [];
  const reported = notes.filter((note) => note.assertionKind === "reported_fact");
  const readings = notes.filter((note) => note.assertionKind === "reported_interpretation");
  const against = notes.filter((note) => note.assertionKind === "rebuttal" || note.assertionKind === "correction");
  const cited = view && result ? sourceNames(view.finding.sourceIds, result) : "";
  return <aside className={`evidence ${open ? "open" : ""}`} ref={panelRef} aria-labelledby="ev-title" aria-hidden={!open} inert={!open} tabIndex={-1}>
    {result && <>
      <div className="ev-head">
        <button className="btn quiet sm" type="button" onClick={onClose}>Back to poster</button>
        {view && !body && <StepNav index={view.index} total={views.length} onStep={onStep} showCount />}
      </div>
      <div className="ev-body">
        {body ? body : view ? <>
          {image && size && <Crop image={image} view={view} size={size} />}
          <div className="ev-title"><h2 id="ev-title" tabIndex={-1}>{view.finding.title}</h2><BasisPill view={view} /></div>
          <p className="ev-short">{view.finding.observedElement}</p>
          <Section title="What was reported">
            <Voice kind="Reported claim" who={cited} text={view.finding.reportedClaim} attribution="Summarized by Muse Spark from the cited sources" />
            {reported.map((note) => <NoteVoice key={note.id} note={note} />)}
          </Section>
          <Section title="How it has been read">
            <Voice kind="Reported reading" who={cited} text={view.finding.reportedInterpretation} attribution="Summarized by Muse Spark from the cited sources" />
            {readings.map((note) => <NoteVoice key={note.id} note={note} />)}
          </Section>
          <Section title="Against this reading">
            {view.finding.counterarguments.map((item, index) => <Voice key={index} kind="Counterargument" who={cited} text={item} against />)}
            {against.map((note) => <NoteVoice key={note.id} note={note} against />)}
            {!view.finding.counterarguments.length && !against.length && <p>No counterargument was supplied. A person reviewing this finding needs to look for one.</p>}
          </Section>
          <Section title="Model inference">
            <Voice kind="Inference" who="Muse Spark" text={view.finding.modelInference} attribution="Written by Muse Spark from these sources. It is not a source." />
          </Section>
          <Section title="How this was found"><HowFound result={result} view={view} /></Section>
          <Section title="Sources">
            {view.webSources.map((source) => <WebSource key={source.id} source={source} />)}
            {pages(notes).map((group) => <RegistryPage key={group[0]!.canonicalUrl} notes={group} />)}
            {view.webSources.length + notes.length > 1 && <p className="fine" style={{ marginTop: 12 }}>Sources that report the same case do not confirm each other independently, and no source here has been verified by a person.</p>}
          </Section>
        </> : <>
          <div className="ev-title"><h2 id="ev-title" tabIndex={-1}>Evidence in this review</h2></div>
          <p className="ev-short">{result.scope.description}</p>
          {result.scope.hasCopy && <Section title="Copy reviewed"><div className="copy-reviewed" lang={textLang(copy)} tabIndex={0} role="region" aria-label="Copy reviewed">{copy}</div></Section>}
          <Section title="Cited web sources">
            {counts && <p className="fine">{plural(counts.webPassages, "cited passage")} from {plural(counts.webPages, "page")} on {plural(counts.webSites, "site")}. One page can support several passages.</p>}
            {result.sources.map((source) => <WebSource key={source.id} source={source} />)}
          </Section>
          <Section title="Documented cases">
            {result.registry.state === "unavailable"
              ? <p>The case registry was unavailable for this review, so no documented case was checked.</p>
              : registry.length
                ? <>{registry.map((note) => <NoteVoice key={note.id} note={note} against={note.assertionKind === "rebuttal" || note.assertionKind === "correction"} />)}
                  {pages(registry).map((group) => <RegistryPage key={group[0]!.canonicalUrl} notes={group} />)}</>
                : <p>{result.registry.checkedCases ? `${result.registry.checkedCases} documented cases were considered, and none had notes eligible for this date.` : "No documented case matched this creative."}</p>}
          </Section>
          <Section title="What this review cannot establish"><ul>{result.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul></Section>
        </>}
      </div>
    </>}
  </aside>;
}
