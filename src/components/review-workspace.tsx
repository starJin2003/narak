"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  IMAGE_TYPES, MAX_COPY_LENGTH, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, REVIEW_TIMEOUT_MS,
  isCalendarDate, reviewResponseSchema, type ReviewIssue, type ReviewResponse,
} from "@/lib/review-contract";
import { buildFindingViews, formatDate, unionBox } from "@/lib/review-view";
import { VARIANT_TIMEOUT_MS, variantResponseSchema } from "@/lib/variant-contract";
import { PosterStage, type PosterImage } from "./poster-stage";
import { EvidencePanel, FindingLens, ResultSummary, StepNav } from "./review-result";
import {
  CompareLayers, VariantEvidence, VariantRequestLens, VariantResultLens, type CompareView, type VariantState,
} from "./variant-compare";

type Evidence = null | "finding" | "all" | "variant";
type Leader = { d: string; length: number; x1: number; y1: number; x2: number; y2: number };

const ISSUE_TITLES = {
  incomplete: { title: "Review incomplete", glyph: "g-incomplete" },
  unavailable: { title: "Live review unavailable", glyph: "g-quiet" },
  failed: { title: "The review could not finish", glyph: "g-incomplete" },
} as const;

// The hosting platform answers some failures itself, as text with no review JSON.
// 413 is its body size limit and 504 its duration limit. Anything else is reported by status.
function platformIssue(status: number, kind: "review" | "variant"): { state: ReviewResponse["state"]; issue: ReviewIssue } {
  if (status === 413) return { state: "failed", issue: { code: "invalid_input", retryable: false, ...(kind === "review" ? { field: "image" as const } : {}),
    message: kind === "review" ? "This upload is larger than the hosting platform accepts. Choose a smaller image file and try again."
      : "This variant request is larger than the hosting platform accepts. Review a smaller image file to test variants." } };
  if (status === 504) return { state: "incomplete", issue: { code: "timeout", retryable: true,
    message: `The hosting platform stopped the ${kind} before it finished. Nothing was assessed. Please try again.` } };
  return { state: "unavailable", issue: { code: "provider_unavailable", retryable: true,
    message: `The ${kind} service sent an unreadable reply (HTTP ${status}). Nothing was assessed. Please try again.` } };
}

const reducedMotion = () => typeof window !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const today = () => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`; };

export function ReviewWorkspace({ configured }: { configured: boolean }) {
  const [copy, setCopy] = useState("");
  const [date, setDate] = useState("");
  const [image, setImage] = useState<PosterImage | null>(null);
  const [issue, setIssue] = useState<ReviewIssue | null>(null);
  const [response, setResponse] = useState<ReviewResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState(false);
  const [reviewedOnce, setReviewedOnce] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [selected, setSelected] = useState(0);
  const [evidence, setEvidence] = useState<Evidence>(null);
  const [arrival, setArrival] = useState(false);
  const [leader, setLeader] = useState<Leader | null>(null);
  const [variant, setVariant] = useState<VariantState | null>(null);
  const [compareView, setCompareView] = useState<CompareView>("split");
  const [split, setSplit] = useState(50);
  const [showChanges, setShowChanges] = useState(false);
  // Setup leads with the poster. Ad copy waits behind a closed disclosure until asked for.
  const [copyOpen, setCopyOpen] = useState(false);
  const variantController = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const stage = useRef<HTMLElement>(null);
  const right = useRef<HTMLElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const lens = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLSpanElement>(null);
  const controller = useRef<AbortController | null>(null);
  const requestNumber = useRef(0);
  const lastTop = useRef<number | null>(null);
  const focusAfter = useRef<"heading" | "marker" | "evidence" | "variant" | null>(null);

  const result = response?.state === "completed" ? response.result : null;
  const view = pending ? "reviewing" : response && !editing ? (result ? (variant?.phase === "done" ? "compare" : "result") : "issue") : "setup";
  const size = result?.segmentation.image ?? null;
  const views = useMemo(() => result ? buildFindingViews(result, image) : [], [result, image]);
  const current = views[selected];

  useEffect(() => () => { if (image) URL.revokeObjectURL(image.url); }, [image]);
  useEffect(() => () => { controller.current?.abort(); variantController.current?.abort(); }, []);

  // Focus moves only after the view it targets has rendered.
  useEffect(() => {
    const target = focusAfter.current;
    focusAfter.current = null;
    if (target === "heading") heading.current?.focus({ preventScroll: false });
    if (target === "marker") (document.querySelector<HTMLElement>('.mk[aria-current="true"]') ?? document.querySelector<HTMLElement>(".lens .btn"))?.focus({ preventScroll: true });
    // The panel turns visible over one frame, even with reduced motion, so focus waits for it.
    if (target === "variant") (document.getElementById("variant-instruction") ?? document.getElementById("variant-title"))?.focus({ preventScroll: true });
    if (target === "evidence") setTimeout(() => document.getElementById("ev-title")?.focus({ preventScroll: true }), 60);
  });

  function changed() {
    setIssue(null);
    setResponse(null);
    setEditing(false);
    setEvidence(null);
    dropVariant();
  }

  function dropVariant() {
    variantController.current?.abort();
    variantController.current = null;
    setVariant(null);
  }

  function chooseImage(file?: File) {
    if (!file || pending) return;
    changed();
    const reject = (message: string) => {
      setIssue({ code: "invalid_input", message, field: "image", retryable: false });
      if (fileInput.current) fileInput.current.value = "";
    };
    if (!IMAGE_TYPES.includes(file.type as typeof IMAGE_TYPES[number])) return reject("Use a JPEG, PNG or WebP image.");
    if (file.size === 0 || file.size > MAX_IMAGE_BYTES) return reject("Use an image of 4 MB or less.");
    const url = URL.createObjectURL(file);
    const probe = new window.Image();
    probe.onload = () => {
      if (!probe.naturalWidth || !probe.naturalHeight) { URL.revokeObjectURL(url); return reject("This image could not be read. Choose another JPEG, PNG or WebP file."); }
      if (probe.naturalWidth * probe.naturalHeight > MAX_IMAGE_PIXELS) { URL.revokeObjectURL(url); return reject("Use an image of 20 megapixels or less."); }
      setImage({ file, url, width: probe.naturalWidth, height: probe.naturalHeight });
    };
    probe.onerror = () => { URL.revokeObjectURL(url); reject("This image could not be read. Choose another JPEG, PNG or WebP file."); };
    probe.src = url;
  }

  function removeImage() {
    changed();
    setImage(null);
    if (fileInput.current) fileInput.current.value = "";
    setTimeout(() => fileInput.current?.focus(), 0);
  }

  function validation(message: string, field: ReviewIssue["field"]) {
    setIssue({ code: "invalid_input", message, field, retryable: false });
    if (field === "copy") { setCopyOpen(true); setTimeout(() => document.getElementById("copy")?.focus(), 0); return; }
    document.getElementById(field === "publicationDate" ? "publication-date" : "poster-file")?.focus();
  }

  async function submit() {
    if (pending) return;
    if (!copy.trim() && !image) return validation("Add a poster or ad copy to review.", "image");
    if (copy.length > MAX_COPY_LENGTH) return validation("Keep ad copy to 5,000 characters or fewer.", "copy");
    if (!isCalendarDate(date)) return validation("Choose the date this runs.", "publicationDate");
    const form = new FormData();
    form.set("copy", copy);
    form.set("publicationDate", date);
    form.set("market", "KR");
    if (image) form.set("image", image.file);
    const active = new AbortController();
    controller.current = active;
    const number = ++requestNumber.current;
    const timer = setTimeout(() => active.abort(), REVIEW_TIMEOUT_MS + 15_000);
    setPending(true);
    setIssue(null);
    setResponse(null);
    setEditing(false);
    setEvidence(null);
    dropVariant();
    setReviewedOnce(true);
    focusAfter.current = "heading";
    let next: ReviewResponse;
    try {
      const reply = await fetch("/api/review", { method: "POST", body: form, signal: active.signal, cache: "no-store" });
      const parsed = reviewResponseSchema.safeParse(await reply.json().catch(() => undefined));
      if (parsed.success) next = parsed.data;
      else { const platform = platformIssue(reply.status, "review"); next = { state: platform.state, result: null, issue: platform.issue } as ReviewResponse; }
    } catch {
      next = { state: active.signal.aborted ? "incomplete" : "unavailable", result: null, issue: {
        code: active.signal.aborted ? "timeout" : "provider_unavailable",
        message: active.signal.aborted ? "The review did not finish in time. Please try again." : "The review could not be reached. Check your connection and try again.",
        retryable: true,
      } };
    } finally {
      clearTimeout(timer);
    }
    if (number !== requestNumber.current) return;
    controller.current = null;
    setPending(false);
    focusAfter.current = "heading";
    if (next.state === "failed" && next.issue.code === "invalid_input") { setIssue(next.issue); return; }
    setResponse(next);
    if (next.state === "completed") {
      const built = buildFindingViews(next.result, image);
      const first = built.findIndex((item) => item.location.kind === "found");
      setSelected(Math.max(0, first));
      lastTop.current = null;
      if (!reducedMotion() && next.result.segmentation.regions.length) {
        setArrival(true);
        setTimeout(() => setArrival(false), 1250);
      }
    }
  }

  function cancel() {
    requestNumber.current += 1;
    controller.current?.abort();
    controller.current = null;
    setPending(false);
    focusAfter.current = "heading";
    setResponse({ state: "incomplete", result: null, issue: {
      code: "cancelled", message: "You stopped this review before it finished. You can edit the creative and run it again.", retryable: true,
    } });
  }

  function edit() {
    setEditing(true);
    if (copy.trim()) setCopyOpen(true);
    setEvidence(null);
    setTimeout(() => document.getElementById("publication-date")?.focus(), 0);
  }

  function backToResult() { setEditing(false); focusAfter.current = "heading"; }

  function newReview() {
    requestNumber.current += 1;
    controller.current?.abort();
    setImage(null); setCopy(""); setDate(""); setIssue(null); setResponse(null); setPending(false);
    setEditing(false); setEvidence(null); setSelected(0); setReviewedOnce(false); setCopyOpen(false); dropVariant();
    focusAfter.current = "heading";
  }

  const select = useCallback((index: number, focusMarker = false) => {
    if (variant?.phase === "pending") return;
    if (variant) { variantController.current = null; setVariant(null); }
    setSelected(index);
    if (evidence === "all") setEvidence("finding");
    focusAfter.current = evidence ? "evidence" : focusMarker ? "marker" : null;
  }, [evidence, variant]);

  const step = useCallback((delta: number) => {
    if (!views.length) return;
    select((selected + delta + views.length) % views.length, !evidence);
  }, [views.length, selected, evidence, select]);

  function openEvidence(mode: Exclude<Evidence, null>) { setEvidence(mode); focusAfter.current = "evidence"; }
  function closeEvidence() { setEvidence(null); focusAfter.current = variant ? "variant" : "marker"; }

  function startVariant() {
    if (current?.location.kind !== "found") return;
    setEvidence(null);
    setVariant({ phase: "form", finding: current.index, regionId: current.location.regions[0]!.id, instruction: "" });
    focusAfter.current = "variant";
  }

  function endVariant() {
    dropVariant();
    setEvidence(null);
    focusAfter.current = "marker";
  }

  async function submitVariant() {
    if (!variant || variant.phase === "pending" || variant.phase === "done" || !result?.variantContext || !image) return;
    const instruction = variant.instruction.trim();
    const base = { finding: variant.finding, regionId: variant.regionId, instruction };
    if (instruction.length < 3) {
      setVariant({ ...base, phase: "failed", issue: { code: "invalid_input", message: "Describe the change in a few words.", retryable: false } });
      focusAfter.current = "variant";
      return;
    }
    const form = new FormData();
    form.set("copy", copy);
    form.set("publicationDate", date);
    form.set("market", "KR");
    form.set("image", image.file);
    form.set("context", result.variantContext);
    form.set("regionId", variant.regionId);
    form.set("instruction", instruction);
    const active = new AbortController();
    variantController.current = active;
    const timer = setTimeout(() => active.abort(), VARIANT_TIMEOUT_MS + 15_000);
    setVariant({ ...base, phase: "pending" });
    focusAfter.current = "variant";
    let next: VariantState;
    try {
      const reply = await fetch("/api/variant", { method: "POST", body: form, signal: active.signal, cache: "no-store" });
      const parsed = variantResponseSchema.safeParse(await reply.json().catch(() => undefined));
      next = !parsed.success ? { ...base, phase: "failed", issue: platformIssue(reply.status, "variant").issue }
        : parsed.data.state === "completed" ? { ...base, phase: "done", result: parsed.data.result } : { ...base, phase: "failed", issue: parsed.data.issue };
    } catch {
      next = { ...base, phase: "failed", issue: {
        code: active.signal.aborted ? "timeout" : "provider_unavailable", retryable: true,
        message: active.signal.aborted ? "The variant did not finish in time. Please try again." : "The variant service could not be reached. Check your connection and try again.",
      } };
    } finally {
      clearTimeout(timer);
    }
    if (variantController.current !== active) return;
    variantController.current = null;
    setVariant(next);
    if (next.phase === "done") { setCompareView("split"); setSplit(50); setShowChanges(false); }
    focusAfter.current = "variant";
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (event.key === "Escape" && evidence) { event.preventDefault(); closeEvidence(); return; }
      if (event.key === "Escape" && variant && variant.phase !== "pending") { event.preventDefault(); endVariant(); return; }
      if (view !== "result" || variant || target.closest("input, textarea, select, summary")) return;
      if (!target.closest(".stage, .evidence")) return;
      if (event.key === "ArrowRight") { event.preventDefault(); step(1); }
      if (event.key === "ArrowLeft") { event.preventDefault(); step(-1); }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // Phones keep the review action in reach until the poster's own controls scroll into view.
  useEffect(() => {
    function update() {
      if (!bar.current || !sentinel.current) return;
      bar.current.classList.toggle("stuck", sentinel.current.getBoundingClientRect().top > innerHeight + 1);
    }
    update();
    addEventListener("scroll", update, { passive: true });
    addEventListener("resize", update);
    return () => { removeEventListener("scroll", update); removeEventListener("resize", update); };
  }, [view, image]);

  // On wide screens the lens card sits level with the selected region and a leader line joins them.
  useLayoutEffect(() => {
    function place() {
      const card = lens.current, column = right.current, poster = frame.current, main = stage.current;
      if (!card || !column || !poster || !main || (view !== "result" && view !== "compare")) { setLeader(null); return; }
      if (matchMedia("(max-width: 1180px)").matches) { card.style.top = ""; setLeader(null); return; }
      const fr = poster.getBoundingClientRect(), cr = column.getBoundingClientRect(), sr = main.getBoundingClientRect();
      if (view === "compare") { card.style.top = `${Math.max(0, fr.top - cr.top)}px`; lastTop.current = null; setLeader(null); return; }
      const height = card.offsetHeight;
      const regions = current?.location.kind === "found" && size ? current.location.regions : [];
      const box = regions.length ? unionBox(regions) : null;
      const cy = box && size ? fr.top + ((box.top + box.bottom) / 2 / size.height) * fr.height : fr.top + height / 2;
      const top = Math.max(0, Math.min(Math.max(cy - height / 2, fr.top), fr.bottom - height) - cr.top);
      card.style.top = `${top}px`;
      if (!reducedMotion() && lastTop.current !== top) {
        card.style.setProperty("--from", `${lastTop.current === null ? 10 : Math.max(-40, Math.min(40, lastTop.current - top))}px`);
        card.classList.remove("enter"); void card.offsetWidth; card.classList.add("enter");
      }
      lastTop.current = top;
      // One region gets a leader. Several matches get none, because a line would pick one of them.
      if (regions.length !== 1 || !box || !size || arrival) { setLeader(null); return; }
      const x1 = fr.left + (box.right / size.width) * fr.width - sr.left, y1 = cy - sr.top;
      const cardTop = cr.top + top;
      const x2 = cr.left - sr.left, y2 = Math.min(Math.max(cy, cardTop + 24), cardTop + height - 24) - sr.top;
      const mx = Math.max(x1 + 16, x2 - 28);
      const d = `M${x1} ${y1} H${mx} L${x2} ${y2}`;
      setLeader((previous) => previous?.d === d ? previous : { d, length: Math.abs(mx - x1) + Math.hypot(x2 - mx, y2 - y1), x1, y1, x2, y2 });
    }
    place();
    const observer = new ResizeObserver(() => place());
    if (stage.current) observer.observe(stage.current);
    return () => observer.disconnect();
  }, [view, selected, current, size, arrival, evidence, variant?.phase]);

  const phone = typeof window !== "undefined" && matchMedia("(max-width: 900px)").matches;
  const ready = Boolean(image || copy.trim()) && isCalendarDate(date);
  const past = isCalendarDate(date) && date < today();
  const needs = !image && !copy.trim() ? (date ? "Add a poster to review." : "Add a poster and the date it runs.")
    : !date ? "Choose the date it runs." : past ? "" : "Ready to review.";
  // The prototype's view names drive the ported layout rules.
  const dataView = view === "setup" ? (image ? "ready" : "empty")
    : view === "issue" ? (response?.state === "unavailable" ? "unavailable" : "incomplete") : view;
  const objectName = image ? image.file.name : view === "setup" ? "New review" : "Copy review";
  const fieldIssue = (field: ReviewIssue["field"]) => issue?.field === field ? issue : null;
  const generalIssue = issue && !issue.field ? issue : null;
  const material = image ? "poster" : "copy";

  const target = variant ? views[variant.finding] : undefined;
  const targetRegions = target?.location.kind === "found" ? target.location.regions : [];
  const comparing = view === "compare" && variant?.phase === "done" ? variant.result : null;

  return <div className={`app ${view} ${evidence && (view === "result" || view === "compare") ? "reading" : ""}`} data-view={dataView}>
    <a className="skip-link" href="#stage">Skip to the poster</a>
    <header className="top">
      <span className="mark">NARAK</span>
      <div className="obj">
        <span className="name" title={objectName}>{objectName}</span>
        {date && view !== "setup" && (view === "reviewing"
          ? <span className="chip">Runs {formatDate(date, true)}</span>
          : <button className="chip" type="button" onClick={edit} aria-label={`Runs ${formatDate(date, true)}. Edit the creative or date`}>Runs {formatDate(date, true)}</button>)}
      </div>
      <div className="top-actions">
        {!configured && <span className="status-note"><span className="status-long">Live review unavailable</span><span className="status-short" aria-hidden="true">Unavailable</span></span>}
        {(view === "result" || view === "compare" || view === "issue") && <button className="btn quiet sm quiet-sm" type="button" aria-label="New review" onClick={newReview}>
          <span className="new-l">New review</span><span className="new-s">New</span></button>}
      </div>
    </header>

    <main className="stage" id="stage" ref={stage} aria-busy={pending} inert={Boolean(evidence) && phone}>
      <section className="left" aria-live="polite">
        {view === "setup" && <>
          <h1 id="page-title" ref={heading} tabIndex={-1}>{editing ? "Edit the creative or date" : "Check a poster before it runs"}</h1>
          <p className="lede">{editing ? "Changing anything replaces the current result." : "Explore how your poster could be interpreted"}</p>
          <p className="fine privacy-wide">Your poster goes to Meta when you review, with any ad copy you add. NARAK does not save uploads or results.</p>
        </>}
        {view === "reviewing" && <>
          <h1 id="page-title" ref={heading} tabIndex={-1}>Reviewing the {material}</h1>
          <p className="lede">A live review can take up to five minutes.</p>
          <p className="fine">Cited web research runs first, then the documented cases and the assessment.{image ? " The elements the assessment names are outlined last." : ""}</p>
          <div><button className="btn quiet sm" type="button" onClick={cancel}>Cancel review</button></div>
        </>}
        {view === "issue" && response && response.state !== "completed" && <>
          <div className="result-head"><span className={`glyph ${ISSUE_TITLES[response.state].glyph}`} aria-hidden="true" /><h1 id="page-title" ref={heading} tabIndex={-1}>{ISSUE_TITLES[response.state].title}</h1></div>
          <p className="lede">{response.issue.message}</p>
          <p className="fine">Nothing was assessed, so nothing on the poster is marked. An unfinished review is never a sign that the creative is clear.</p>
          <div className="row">
            {response.issue.retryable && <button className="btn" type="button" onClick={submit}>Review again</button>}
            <button className="btn quiet" type="button" onClick={edit}>Edit the creative</button>
          </div>
        </>}
        {(view === "result" || view === "compare") && result && <ResultSummary result={result} views={views} selected={selected} onSelect={(index) => select(index)}
          onEdit={edit} onAllEvidence={() => openEvidence("all")} headingRef={heading} />}
      </section>

      <div className="center">
        <PosterStage image={image} copy={copy} mode={view} views={views} selected={selected} onSelect={select}
          segmentationSize={size} arrival={arrival} frameRef={frame} dragging={dragging} onDragging={setDragging}
          onFile={chooseImage} onImageError={() => { setImage(null); setIssue({ code: "invalid_input", message: "This image could not be shown. Choose another JPEG, PNG or WebP file.", field: "image", retryable: false }); }}
          fileInput={fileInput} describedBy="file-error" invalid={Boolean(fieldIssue("image"))}
          scanning={variant?.phase === "pending"}
          focusHidden={Boolean(comparing && compareView === "variant" && comparing.redetection.targetStillDetected === false)}
          hideRegions={comparing ? new Set(views.flatMap((item) => item.location.kind === "found" ? item.location.regions.map((region) => region.id) : []).filter((id) => id !== comparing.target.regionId)) : undefined}
          layers={comparing ? <CompareLayers result={comparing} view={compareView} split={split} showChanges={showChanges} onSplit={setSplit} /> : undefined} />
        {view === "setup" && image && <div className="frame-tools" role="group" aria-label="Poster image">
          <button className="btn quiet sm" type="button" onClick={() => fileInput.current?.click()}>Replace</button>
          <button className="btn quiet sm" type="button" onClick={removeImage}>Remove</button>
        </div>}
        <p className="err" id="file-error" role="alert" hidden={!fieldIssue("image")}>{fieldIssue("image")?.message}</p>
        {view === "setup" && <>
          <div className="strip setup-act" ref={bar}>
            <div className="date-field">
              <label htmlFor="publication-date">Runs on</label>
              <input id="publication-date" type="date" min="0001-01-01" max="9999-12-31" value={date} required
                aria-invalid={Boolean(fieldIssue("publicationDate"))} aria-describedby="needs date-note date-error"
                onChange={(event) => { changed(); setDate(event.target.value); }} />
            </div>
            <button className="btn" type="button" aria-disabled={!ready} aria-describedby="needs" onClick={submit}>
              {reviewedOnce ? "Review again" : image || !copy.trim() ? "Review poster" : "Review copy"}
            </button>
            {editing && result && <button className="textbtn" type="button" onClick={backToResult}>Back to the result</button>}
            <p className="note" id="needs">{needs}</p>
            <p className="note" id="date-note" hidden={!past}>A past date makes this a retrospective review. Documented cases count only if they were reported before that day.</p>
            <p className="err" id="date-error" role="alert" hidden={!fieldIssue("publicationDate") && !generalIssue}>{(fieldIssue("publicationDate") ?? generalIssue)?.message}</p>
          </div>
          <span className="sentinel" ref={sentinel} aria-hidden="true" />
          {/* Phones show the privacy line under the action, so the poster still leads the screen. */}
          <p className="fine privacy-narrow">Your poster goes to Meta when you review, with any ad copy you add. NARAK does not save uploads or results.</p>
        </>}
        {view === "result" && views.length > 1 && !variant && <div className="strip"><StepNav index={selected} total={views.length} onStep={step} showCount /></div>}
        {comparing && <div className="strip">
          <div className="seg" role="group" aria-label="Comparison view">
            {(["original", "split", "variant"] as const).map((key) => <button key={key} type="button" aria-pressed={compareView === key} onClick={() => setCompareView(key)}>
              {key === "original" ? "Original" : key === "split" ? "Split" : "Variant"}</button>)}
          </div>
          <button className="btn quiet sm" type="button" aria-pressed={showChanges} onClick={() => setShowChanges((value) => !value)}>
            {showChanges ? "Hide measured changes" : "Show measured changes"}</button>
        </div>}
      </div>

      {view === "setup" && <div className="right">
        <details className="about copy-add" open={copyOpen} onToggle={(event) => setCopyOpen(event.currentTarget.open)}>
          <summary>{copy.trim() ? "Ad copy added" : "Add ad copy"}</summary>
          <div className="field-label"><label htmlFor="copy">Ad copy, optional</label><span id="copy-count">{copy.length.toLocaleString("en-US")} / 5,000</span></div>
          <textarea id="copy" value={copy} maxLength={MAX_COPY_LENGTH} rows={4} placeholder="Headline, caption or campaign copy in Korean or English"
            aria-describedby="copy-count copy-error" aria-invalid={Boolean(fieldIssue("copy"))}
            onChange={(event) => { changed(); setCopy(event.target.value); }} />
          <p className="err" id="copy-error" role="alert" hidden={!fieldIssue("copy")}>{fieldIssue("copy")?.message}</p>
        </details>
      </div>}

      {(view === "result" || view === "compare") && result && <aside className="right" ref={right} aria-label={variant ? "Controlled variant" : "Selected finding"}>
        {comparing ? <VariantResultLens result={comparing} lensRef={lens} onFindings={() => openEvidence("variant")} onClose={endVariant} />
          : variant && variant.phase !== "done" ? <VariantRequestLens state={variant} regions={targetRegions} concept={target?.location.kind === "found" ? target.location.concept : "element"} lensRef={lens}
            onInstruction={(value) => setVariant({ phase: "form", finding: variant.finding, regionId: variant.regionId, instruction: value })}
            onRegion={(id) => setVariant({ ...variant, regionId: id })} onSubmit={submitVariant} onCancel={endVariant} />
          : <FindingLens result={result} view={current} total={views.length} onStep={step} onVariant={startVariant}
            onEvidence={() => openEvidence(current ? "finding" : "all")} lensRef={lens}
            canVariant={Boolean(result.variantContext && image && current?.location.kind === "found")} />}
      </aside>}
      {leader && view === "result" && !evidence && <svg className="leader" aria-hidden="true">
        <defs><linearGradient id="leader-light" gradientUnits="userSpaceOnUse" x1={leader.x1} y1={leader.y1} x2={leader.x2} y2={leader.y2}>
          <stop offset="0" stopColor="#71F6D2" /><stop offset=".3" stopColor="#0DACF1" /><stop offset="1" stopColor="#F5A3E0" />
        </linearGradient></defs>
        <path d={leader.d} className={reducedMotion() ? "" : "draw"} style={{ "--len": leader.length } as CSSProperties} />
        <circle className="a" cx={leader.x1} cy={leader.y1} r="3" /><circle className="b" cx={leader.x2} cy={leader.y2} r="2.5" />
      </svg>}
    </main>

    <EvidencePanel open={Boolean(evidence) && (view === "result" || view === "compare")} result={result} view={evidence === "finding" ? current ?? null : null} views={views}
      image={image} size={size} copy={copy} onClose={closeEvidence} onStep={step} panelRef={panel}
      body={evidence === "variant" && comparing ? <VariantEvidence result={comparing} /> : undefined} />
  </div>;
}
