"use client";

import type { CSSProperties, Ref } from "react";
import Image from "next/image";
import type { Region, ReviewIssue } from "@/lib/review-contract";
import { MAX_INSTRUCTION_LENGTH, type Reassessment, type VariantResult } from "@/lib/variant-contract";
import { OUTCOMES, maskTransform, plural, textLang } from "@/lib/review-view";

export type CompareView = "original" | "split" | "variant";

export type VariantState =
  | { phase: "form" | "pending"; finding: number; regionId: string; instruction: string }
  | { phase: "failed"; finding: number; regionId: string; instruction: string; issue: ReviewIssue }
  | { phase: "done"; finding: number; regionId: string; instruction: string; result: VariantResult };

const percent = (value: number) => `${Math.round(value * 100)}%`;
const outcomeLabel = (item: Reassessment) => item.state === "completed" ? OUTCOMES[item.outcome].label : "Did not finish";
const naming = (item: Reassessment, concept: string) => item.state === "completed"
  ? item.findings.filter((finding) => finding.visualConcept?.toLowerCase() === concept.toLowerCase()).length : null;

function redetectionText({ redetection, target }: VariantResult): string {
  if (redetection.status === "failed" || redetection.status === "skipped" || redetection.targetStillDetected === null) return "Check did not finish";
  const selected = redetection.targetStillDetected ? `Still finds the ${target.concept} in the selected area` : `No ${target.concept} in the selected area`;
  if (!redetection.otherMatches) return selected;
  const kept = redetection.otherMatches - (redetection.otherMatchesMissing ?? 0);
  return `${selected}. ${kept} of ${redetection.otherMatches} other matches still found`;
}

// The card beside the poster while a variant is requested, made or failed.
export function VariantRequestLens({ state, regions, concept, lensRef, onInstruction, onRegion, onSubmit, onCancel }: {
  state: Exclude<VariantState, { phase: "done" }>; regions: Region[]; concept: string; lensRef: Ref<HTMLDivElement>;
  onInstruction: (value: string) => void; onRegion: (id: string) => void; onSubmit: () => void; onCancel: () => void;
}) {
  const pending = state.phase === "pending";
  return <div className="lens cmp" ref={lensRef} role="region" aria-label="Controlled variant" aria-busy={pending}>
    <div className="lens-top"><span className="fine">Controlled variant</span><span className="pill planned">Muse Image</span></div>
    <h2 id="variant-title" tabIndex={-1}>{pending ? `Changing the ${concept}` : `Change the ${concept}`}</h2>
    {pending
      ? <p>Muse Image is making the variant. NARAK then reviews both versions with the same evidence and date. This can take up to three minutes.</p>
      : <p>Muse Image makes an edited copy of the poster. NARAK then reviews the original and the copy with the same evidence and date.</p>}
    {!pending && <form className="variant-form" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
      {regions.length > 1 && <div>
        <span className="field-label" id="variant-area">SAM 3.1 outlined {regions.length} areas. Choose one to change.</span>
        <div className="seg" role="group" aria-labelledby="variant-area">
          {regions.map((region, index) => <button key={region.id} type="button" aria-pressed={state.regionId === region.id} onClick={() => onRegion(region.id)}>Area {index + 1}</button>)}
        </div>
      </div>}
      <label htmlFor="variant-instruction">What should change?</label>
      <input id="variant-instruction" value={state.instruction} maxLength={MAX_INSTRUCTION_LENGTH} autoComplete="off"
        placeholder="Replace it with a paper cup" aria-describedby="variant-note variant-error" aria-invalid={state.phase === "failed" && state.issue.code === "invalid_input"}
        onChange={(event) => onInstruction(event.target.value)} />
      <p className="err" id="variant-error" role="alert" hidden={state.phase !== "failed"}>{state.phase === "failed" ? state.issue.message : ""}</p>
      <p className="fine" id="variant-note">The variant is a generated image and is labeled as one. It never replaces the review of your poster.</p>
      <div className="acts" style={{ marginTop: 4 }}>
        <button className="btn sm" type="submit" aria-disabled={state.instruction.trim().length < 3}>Make variant</button>
        <button className="btn quiet sm" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>}
    {pending && <div className="acts"><button className="btn quiet sm" type="button" onClick={onCancel}>Stop</button></div>}
  </div>;
}

// The card beside the poster once both versions are reviewed.
export function VariantResultLens({ result, lensRef, onFindings, onClose }: {
  result: VariantResult; lensRef: Ref<HTMLDivElement>; onFindings: () => void; onClose: () => void;
}) {
  const { original, variant, preservation, redetection, target } = result;
  const incomplete = original.state === "failed" || variant.state === "failed";
  const before = naming(original, target.concept), after = naming(variant, target.concept);
  return <div className="lens cmp" ref={lensRef} role="region" aria-label="Variant comparison">
    <div className="lens-top"><span className="fine">Controlled variant</span>
      <span className={`pill ${incomplete ? "none" : "planned"}`}>{incomplete ? "Comparison incomplete" : "Generated"}</span></div>
    <h2 id="variant-title" tabIndex={-1}>Change the {target.concept}</h2>
    <p lang={textLang(result.instruction)}>&ldquo;{result.instruction}&rdquo;</p>
    <dl>
      <div><dt>First review of the original</dt><dd>{OUTCOMES[result.firstReview.outcome].label}, {plural(result.firstReview.findings, "finding")}</dd></div>
      <div><dt>Outcome, original reviewed again</dt><dd>{outcomeLabel(original)}</dd></div>
      <div><dt>Outcome, generated variant</dt><dd>{outcomeLabel(variant)}</dd></div>
      {before !== null && after !== null && <div><dt>Findings naming the {target.concept}</dt><dd>{before} in the original, {after} in the variant</dd></div>}
      <div><dt>SAM 3.1 on the variant</dt><dd>{redetectionText(result)}</dd></div>
      <div><dt>Measured change</dt><dd>{percent(preservation.insideChangedShare)} of the selected area, {percent(preservation.outsideChangedShare)} of everything else</dd></div>
    </dl>
    {(redetection.otherMatchesMissing ?? 0) > 0 && <p className="warn">Another {target.concept} outside the selected area is gone, so the edit may have changed a different element.</p>}
    {result.originalMatchesFirstReview === false && <p className="warn">The unchanged original was assessed differently this time, so this comparison cannot isolate the edit.</p>}
    {preservation.material && <p className="warn">Areas outside the element also changed. Any difference may come from them.</p>}
    <div className="acts">
      <button className="btn sm" type="button" onClick={onFindings}>Compare findings</button>
      <button className="btn quiet sm" type="button" onClick={onClose}>Back to findings</button>
    </div>
  </div>;
}

function VersionFindings({ title, item }: { title: string; item: Reassessment }) {
  return <section className="ev-sec">
    <h3>{title}</h3>
    {item.state === "failed" ? <p>{item.message}</p> : <>
      <p><b>{OUTCOMES[item.outcome].label}.</b> {item.findings.length === 0 ? "No finding was supported." : `${item.findings.length} ${item.findings.length === 1 ? "finding" : "findings"}.`}</p>
      {item.findings.map((finding, index) => <div className="src" key={index}>
        <div className="src-top"><b>{finding.title}</b><span className="fine">{finding.sourceIds.join(", ")}</span></div>
        <p className="fine">{finding.observedElement}</p>
        <p style={{ margin: 0 }}>{finding.modelInference}</p>
      </div>)}
    </>}
  </section>;
}

export function VariantEvidence({ result }: { result: VariantResult }) {
  return <>
    <div className="ev-title"><h2 id="ev-title" tabIndex={-1}>Findings in each version</h2><span className="pill planned">Generated variant</span></div>
    <p>Both versions were reviewed again with the same cited passages, registry notes and date. Source IDs refer to the sources of the first review.</p>
    <VersionFindings title="Original poster, reviewed again" item={result.original} />
    <VersionFindings title="Generated variant" item={result.variant} />
    <section className="ev-sec"><h3>What this comparison can show</h3><ul>{result.notes.map((note, index) => <li key={index}>{note}</li>)}</ul></section>
    <section className="ev-sec"><h3>How the change was measured</h3>
      <p>NARAK compared the two images in small cells at a reduced size. A cell counts as changed when its average color difference passes a fixed threshold. The selected area is the element&apos;s box with a small margin. The measurement shows where pixels differ, not whether the meaning changed.</p>
      {result.preservation.cellsTruncated && <p className="fine">Only the first 800 changed strips are drawn on the poster.</p>}
    </section>
  </>;
}

// Layers drawn inside the poster frame during a comparison.
export function CompareLayers({ result, view, split, showChanges, onSplit }: {
  result: VariantResult; view: CompareView; split: number; showChanges: boolean; onSplit: (value: number) => void;
}) {
  const at = view === "variant" ? 0 : view === "original" ? 100 : split;
  const size = { width: result.image.width, height: result.image.height };
  const clip = { clipPath: `inset(0 0 0 ${at}%)` };
  // A positioned layer, so the filled variant image has a positioned parent of the frame's size.
  return <div className="cmp-layers" style={{ "--split": `${at}%` } as CSSProperties}>
    {view !== "original" && <Image className="vlayer" src={result.image.dataUrl} unoptimized fill sizes="60vw"
      alt={`Generated variant of the poster with the ${result.target.concept} changed`} />}
    {view !== "original" && showChanges && <svg className="overlay" viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="none" style={{ ...clip, zIndex: 2 }} aria-hidden="true">
      {result.preservation.changedCells.map((cell, index) => <rect key={index} x={cell.left} y={cell.top} width={cell.right - cell.left} height={cell.bottom - cell.top} fill="rgba(245,163,224,.32)" />)}
    </svg>}
    {view !== "original" && result.redetection.regions.length > 0 && <svg className="overlay" viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="none" style={clip} aria-hidden="true">
      {result.redetection.regions.map((region, index) => region.mask
        ? <path key={index} className="mask other" d={region.mask.path} transform={maskTransform(region.mask)} fillRule="evenodd" />
        : <rect key={index} className="mask other" x={region.box.left} y={region.box.top} width={region.box.right - region.box.left} height={region.box.bottom - region.box.top} />)}
    </svg>}
    {view === "split" && <>
      <div className="divider" />
      <span className="tag l">Original</span><span className="tag r"><span className="tag-long">Generated variant</span><span className="tag-short">Generated</span></span>
      <input type="range" className="split-range" min={0} max={100} value={split} onChange={(event) => onSplit(Number(event.target.value))}
        aria-label="Comparison position, with the original on the left and the generated variant on the right" />
    </>}
    {view === "variant" && <span className="gen-label">Generated by Muse Image</span>}
  </div>;
}
