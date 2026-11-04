"use client";

import type { CSSProperties, ReactNode, Ref } from "react";
import Image from "next/image";
import type { ReviewResult, ReviewSource } from "@/lib/review-contract";
import {
  BASIS_LABEL, OUTCOMES, closeView, formatDate, hostname, locationDetail, locationLabel,
  displayPassage, maskTransform, plural, sourceCounts, textLang, unionBox, type FindingView, type RegistryNote,
} from "@/lib/review-view";
import type { PosterImage } from "./poster-stage";

export function Chevron({ left = false }: { left?: boolean }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={left ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7"} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

export function StepNav({ index, total, onStep, label = "Move between findings", showCount = false }: {
  index: number; total: number; onStep: (delta: number) => void; label?: string; showCount?: boolean;
}) {
  if (total < 2) return null;
  return <div className="nav" role="group" aria-label={label}>
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
    </div>
    <p className="lede">{result.summary}</p>
    <details className="about">
      <summary>About this outcome</summary>
      <div className="about-body">
        <p>{outcome.note}</p>
        <dl className="measure">
          <dt>Runs on</dt><dd><b>{formatDate(scope.publicationDate)}</b></dd>
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
          <span><b>{view.finding.title}</b><small>{locationLabel(view.location)}</small></span>
        </button>
      </li>)}
    </ol>}
    <div className="tools" style={{ justifyContent: "flex-start" }}>
      <button className="textlink" type="button" onClick={onAllEvidence}>All evidence</button>
      <button className="textlink" type="button" onClick={onEdit}>Edit the creative or date</button>
    </div>
  </>;
}

export function FindingLens({ result, view, total, onStep, onEvidence, onVariant, lensRef, canVariant }: {
  result: ReviewResult; view: FindingView | undefined; total: number; onStep: (delta: number) => void;
  onEvidence: () => void; onVariant?: () => void; lensRef: Ref<HTMLDivElement>; canVariant: boolean;
}) {
  if (!view) {
    return <div className="lens" ref={lensRef} role="region" aria-label="What was checked">
      <div className="lens-top"><span className="kicker">What was checked</span><span className="pill neutral">{plural(sourceCounts(result).webPages, "cited page")}</span></div>
      <h2>{OUTCOMES[result.outcome].label}</h2>
      <p>{result.scope.description}</p>
      <div className="acts"><button className="btn quiet sm" type="button" onClick={onEvidence}>How it was checked</button></div>
    </div>;
  }
  return <div className="lens" ref={lensRef} role="region" aria-label={`Finding ${view.number} of ${total}`}>
    <div className="lens-top"><span className="kicker">Finding {view.number} of {total}</span><BasisPill view={view} /></div>
    <h2>{view.finding.title}</h2>
    <p>{view.finding.observedElement}</p>
    <p className="region-note">{locationDetail(view.location)}{view.sharedWith.length > 0 && ` The same element also appears in finding ${view.sharedWith.join(" and ")}.`}</p>
    <div className="acts">
      <button className="btn sm" type="button" onClick={onEvidence}>Evidence</button>
      {canVariant && onVariant && <button className="btn quiet sm" type="button" onClick={onVariant}>Test a variant</button>}
      <StepNav index={view.index} total={total} onStep={onStep} />
    </div>
  </div>;
}

function Crop({ image, view, size }: { image: PosterImage; view: FindingView; size: { width: number; height: number } }) {
  if (view.location.kind !== "found") return null;
  const regions = view.location.regions;
  const area = closeView(unionBox(regions), size);
  const ratio = area.width / area.height;
  const pct = (value: number, total: number) => `${(value / total) * 100}%`;
  return <figure className="crop" style={{ aspectRatio: `${area.width} / ${area.height}`, width: `min(100%, ${Math.round(320 * ratio)}px)` } as CSSProperties}>
    <Image src={image.url} alt="" unoptimized width={size.width} height={size.height}
      style={{ position: "absolute", maxWidth: "none", left: `-${pct(area.x, area.width)}`, top: `-${pct(area.y, area.height)}`, width: pct(size.width, area.width), height: pct(size.height, area.height) }} />
    <svg viewBox={`${area.x} ${area.y} ${area.width} ${area.height}`} preserveAspectRatio="none" style={{ position: "absolute", inset: 0 }} role="img"
      aria-label={`Close view of ${regions.length === 1 ? "the area" : `${regions.length} areas`} matching ${view.location.concept}`}>
      {regions.map((region) => region.mask
        ? <path key={region.id} className="mask" d={region.mask.path} transform={maskTransform(region.mask)} fillRule="evenodd" />
        : <rect key={region.id} className="mask" x={region.box.left} y={region.box.top} width={region.box.right - region.box.left} height={region.box.bottom - region.box.top} />)}
    </svg>
    <figcaption>Outline by SAM 3.1</figcaption>
  </figure>;
}

function WebSource({ source }: { source: ReviewSource }) {
  return <div className="src" id={`source-${source.id}`}>
    <div className="src-top"><b>{source.id}, cited web source</b><span className="pill neutral">Unverified</span></div>
    <a href={source.annotation.url} target="_blank" rel="noopener noreferrer">{source.annotation.title || hostname(source.annotation.url)}<span className="sr-only"> (opens in a new tab)</span></a>
    <span className="fine">{hostname(source.annotation.url)}</span>
    <p className="passage">{displayPassage(source.citedPassage)}</p>
    <p className="fine">This passage is the research text the citation supports. It is not a quotation from the page, and the page still needs a person to check it.</p>
    <details><summary>Citation trace</summary><dl>
      <dt>Response</dt><dd>{source.responseId}</dd>
      <dt>Message and block</dt><dd>{source.messageId}, block {source.blockIndex}</dd>
      <dt>Character span</dt><dd>{source.annotation.start_index} to {source.annotation.end_index}</dd>
    </dl></details>
  </div>;
}

const ASSERTION_LABEL = {
  reported_fact: "Reported fact", reported_interpretation: "Reported interpretation", rebuttal: "Rebuttal", correction: "Correction",
} as const;

function RegistrySource({ note }: { note: RegistryNote }) {
  return <div className="src" id={`source-${note.id}`}>
    <div className="src-top"><b>{note.id}, {ASSERTION_LABEL[note.assertionKind].toLowerCase()}</b>
      <span className={`pill ${note.caseStatus === "verified" ? "concern" : "emerging"}`}>{note.caseStatus === "verified" ? "Verified case" : "Emerging case"}</span></div>
    <a href={note.canonicalUrl} target="_blank" rel="noopener noreferrer">{note.title}<span className="sr-only"> (opens in a new tab)</span></a>
    <span className="fine">{note.publisher ?? hostname(note.canonicalUrl)}, published {formatDate(note.publishedOn)}</span>
    <p className="passage">{note.assertionText}</p>
    <p className="fine">{note.attribution}</p>
    <details><summary>Registry record</summary><dl>
      <dt>Case and evidence</dt><dd>{note.caseId}, {note.evidenceId}</dd>
      <dt>Available from</dt><dd>{note.availableAt}</dd>
      <dt>Provenance</dt><dd>{note.provenance}</dd>
    </dl></details>
  </div>;
}

function Section({ title, children, className = "" }: { title: string; children: ReactNode; className?: string }) {
  return <section className={`ev-sec ${className}`}><h3>{title}</h3>{children}</section>;
}

export function EvidencePanel({ open, result, view, views, image, size, copy, onClose, onStep, panelRef, body }: {
  open: boolean; result: ReviewResult | null; view: FindingView | null; views: FindingView[];
  image: PosterImage | null; size: { width: number; height: number } | null; copy: string;
  onClose: () => void; onStep: (delta: number) => void; panelRef: Ref<HTMLElement>; body?: ReactNode;
}) {
  const registry = result?.registry.state === "available" ? result.registry.evidence : [];
  const counts = result ? sourceCounts(result) : null;
  return <aside className={`evidence ${open ? "open" : ""}`} ref={panelRef} aria-labelledby="ev-title" aria-hidden={!open} inert={!open}>
    {result && <>
      <div className="ev-head">
        <button className="btn quiet sm" type="button" onClick={onClose}>Back to poster</button>
        {view && !body && <StepNav index={view.index} total={views.length} onStep={onStep} showCount />}
      </div>
      <div className="ev-body">
        {body ? body : view ? <>
          {image && size && <Crop image={image} view={view} size={size} />}
          <div className="ev-title"><h2 id="ev-title" tabIndex={-1}>{view.finding.title}</h2><BasisPill view={view} /></div>
          <Section title="In the creative"><p>{view.finding.observedElement}</p></Section>
          <Section title="What sources report"><p>{view.finding.reportedClaim}</p></Section>
          <Section title="How it has been read"><p>{view.finding.reportedInterpretation}</p></Section>
          <Section title="Against this reading" className="against">
            {view.finding.counterarguments.length
              ? <ul>{view.finding.counterarguments.map((item, index) => <li key={index}>{item}</li>)}</ul>
              : <p>No counterargument was supplied. A person reviewing this finding needs to look for one.</p>}
          </Section>
          <Section title="Model inference">
            <div className="inference"><p>{view.finding.modelInference}</p></div>
            <p className="fine" style={{ marginTop: 8 }}>Written by Muse Spark from the sources below. It is not a source.</p>
          </Section>
          {view.location.kind !== "no_image" && <Section title="Where it appears"><p>{locationDetail(view.location)}</p>
            <p className="fine" style={{ marginTop: 8 }}>An outline shows where a named element is. It does not establish meaning, intent or risk.</p></Section>}
          <Section title="Sources for this finding">
            {view.webSources.map((source) => <WebSource key={source.id} source={source} />)}
            {view.registryNotes.map((note) => <RegistrySource key={note.id} note={note} />)}
          </Section>
        </> : <>
          <div className="ev-title"><h2 id="ev-title" tabIndex={-1}>Evidence in this review</h2></div>
          <p>{result.scope.description}</p>
          {result.scope.hasCopy && <Section title="Copy reviewed"><div className="copy-reviewed" lang={textLang(copy)} tabIndex={0} role="region" aria-label="Copy reviewed">{copy}</div></Section>}
          <Section title="Cited web sources">
            {counts && <p className="fine">{plural(counts.webPassages, "cited passage")} from {plural(counts.webPages, "page")} on {plural(counts.webSites, "site")}. One page can support several passages.</p>}
            {result.sources.map((source) => <WebSource key={source.id} source={source} />)}
          </Section>
          <Section title="Documented cases">
            {result.registry.state === "unavailable"
              ? <p>The case registry was unavailable for this review, so no documented case was checked.</p>
              : registry.length
                ? <>{registry.map((note) => <RegistrySource key={note.id} note={note} />)}</>
                : <p>{result.registry.checkedCases ? `${result.registry.checkedCases} documented cases were considered, and none had notes eligible for this date.` : "No documented case matched this creative."}</p>}
          </Section>
          <Section title="What this review cannot establish"><ul>{result.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul></Section>
        </>}
      </div>
    </>}
  </aside>;
}
