"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Image from "next/image";
import {
  IMAGE_TYPES, MAX_COPY_LENGTH, MAX_IMAGE_BYTES, REVIEW_TIMEOUT_MS,
  isCalendarDate, reviewResponseSchema, type ReviewIssue, type ReviewResponse,
} from "@/lib/review-contract";
import { ReviewResultPanel } from "./review-result";

type SelectedImage = { file: File; url: string };

export function ReviewWorkspace({ configured }: { configured: boolean }) {
  const [copy, setCopy] = useState("");
  const [date, setDate] = useState("");
  const [image, setImage] = useState<SelectedImage | null>(null);
  const [issue, setIssue] = useState<ReviewIssue | null>(null);
  const [response, setResponse] = useState<ReviewResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [edited, setEdited] = useState(false);
  const [hasReviewed, setHasReviewed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const controller = useRef<AbortController | null>(null);
  const requestNumber = useRef(0);

  useEffect(() => () => { if (image) URL.revokeObjectURL(image.url); }, [image]);
  useEffect(() => () => { controller.current?.abort(); }, []);

  function changed() {
    setIssue(null);
    setResponse(null);
    setEdited(hasReviewed);
  }

  function chooseImage(file?: File) {
    if (!file || pending) return;
    changed();
    if (file.size === 0 || file.size > MAX_IMAGE_BYTES || !IMAGE_TYPES.includes(file.type as typeof IMAGE_TYPES[number])) {
      setIssue({ code: "invalid_input", message: "Choose a nonempty JPEG, PNG, or WebP image up to 4 MB.", field: "image", retryable: false });
      setImage(null);
      if (fileInput.current) fileInput.current.value = "";
      return;
    }
    setImage({ file, url: URL.createObjectURL(file) });
  }

  function validation(message: string, field: ReviewIssue["field"]) {
    setIssue({ code: "invalid_input", message, field, retryable: false });
    document.getElementById(field === "publicationDate" ? "publication-date" : field === "image" ? "image-upload" : "copy")?.focus();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (!copy.trim() && !image) return validation("Add advertisement copy or an image to begin.", "copy");
    if (copy.length > MAX_COPY_LENGTH) return validation("Keep advertisement copy to 5,000 characters or fewer.", "copy");
    if (!isCalendarDate(date)) return validation("Choose a valid publication date.", "publicationDate");
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
    setEdited(false);
    setHasReviewed(true);
    try {
      const result = await fetch("/api/review", { method: "POST", body: form, signal: active.signal, cache: "no-store" });
      const parsed = reviewResponseSchema.safeParse(await result.json());
      if (!parsed.success) throw new Error("Invalid review response");
      if (number !== requestNumber.current) return;
      setResponse(parsed.data);
      if (parsed.data.state === "failed" && parsed.data.issue.code === "invalid_input") setIssue(parsed.data.issue);
    } catch {
      if (number !== requestNumber.current) return;
      setResponse({ state: active.signal.aborted ? "incomplete" : "unavailable", result: null, issue: {
        code: active.signal.aborted ? "timeout" : "provider_unavailable",
        message: active.signal.aborted ? "The review did not finish in time. Please try again." : "The review could not be reached. Check your connection and try again.",
        retryable: true,
      } });
    } finally {
      clearTimeout(timer);
      if (number === requestNumber.current) {
        setPending(false);
        controller.current = null;
        resultHeading.current?.focus();
      }
    }
  }

  function cancel() {
    requestNumber.current += 1;
    controller.current?.abort();
    controller.current = null;
    setPending(false);
    setResponse({ state: "incomplete", result: null, issue: {
      code: "cancelled", message: "You stopped this review before it finished. You can edit the creative and run it again.", retryable: true,
    } });
    resultHeading.current?.focus();
  }

  return <>
    <a className="skip-link" href="#review-form">Skip to creative review</a>
    <header className="site-header">
      <div className="wordmark" aria-label="NARAK">NARAK<span className="brand-dot" aria-hidden="true" /></div>
      <span className="header-description">A little context. A considered release.</span>
      <span className={`connection-state ${configured ? "configured" : ""}`}><span aria-hidden="true" />{configured ? "Creative review workspace" : "Live review unavailable"}</span>
    </header>
    <main className="workspace">
      <section className="intro" aria-labelledby="page-title">
        <div><p className="eyebrow">Cultural context / South Korea</p><h1 id="page-title">Before it goes public.</h1></div>
        <p className="intro-description">See your creative in context.<br />Review the words, the image, and the moment<br className="desktop-break" /> with an evidence trail you can follow.</p>
      </section>
      <div className="workspace-grid">
        <section className="creative-panel" aria-labelledby="creative-title">
          <div className="panel-heading"><h2 id="creative-title"><span>01</span> The creative</h2><span className="panel-note">Your next release</span></div>
          <form id="review-form" onSubmit={submit} noValidate>
            <fieldset disabled={pending}>
              <legend className="sr-only">Advertisement details</legend>
              <div className="field-heading"><label htmlFor="image-upload">Advertisement image</label><span>Optional</span></div>
              <div className={`upload-area ${image ? "has-image" : ""} ${dragging ? "is-dragging" : ""}`}
                onDragOver={(event) => { event.preventDefault(); if (!pending) setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => { event.preventDefault(); setDragging(false); chooseImage(event.dataTransfer.files[0]); }}>
                {image ? <>
                  <Image className="creative-preview" src={image.url} alt="Preview of your advertisement" width={900} height={600} unoptimized onError={() => {
                    setImage(null);
                    setIssue({ code: "invalid_input", message: "This image could not be previewed. Choose a valid JPEG, PNG, or WebP image.", field: "image", retryable: false });
                    if (fileInput.current) fileInput.current.value = "";
                  }} />
                  <button className="remove-image" type="button" onClick={() => { changed(); setImage(null); if (fileInput.current) fileInput.current.value = ""; }}>Remove image <span aria-hidden="true">&#215;</span></button>
                </> : <div className="upload-prompt" aria-hidden="true">
                  <svg width="36" height="36" viewBox="0 0 36 36" fill="none"><path d="M8 13V8h5M23 8h5v5M28 23v5h-5M13 28H8v-5M18 11v14M11 18h14" stroke="currentColor" strokeWidth="1.3" /></svg>
                  <span className="upload-title">Place your creative here</span><span className="upload-subtitle">Drop an image or choose a file</span>
                </div>}
                <input className={`file-input ${image ? "file-input-hidden" : ""}`} id="image-upload" type="file" accept={IMAGE_TYPES.join(",")} ref={fileInput} aria-describedby="image-help" aria-invalid={issue?.field === "image"} onChange={(event) => chooseImage(event.target.files?.[0])} />
              </div>
              <p id="image-help" className="field-help">JPEG, PNG, or WebP. Up to 4 MB and 20 megapixels. {image && <span className="selected-filename">{image.file.name}</span>}</p>
              <div className="copy-field">
                <div className="field-heading"><label htmlFor="copy">Advertisement copy</label><span id="copy-count">{copy.length.toLocaleString("en-US")} / 5,000</span></div>
                <textarea id="copy" name="copy" value={copy} maxLength={MAX_COPY_LENGTH} rows={5} placeholder="Paste your headline, caption, or campaign copy..." aria-describedby="copy-help copy-count" aria-invalid={issue?.field === "copy"} onChange={(event) => { changed(); setCopy(event.target.value); }} />
                <p id="copy-help" className="field-help">Korean and English input supported. An image or copy is required.</p>
              </div>
              <div className="timing-row">
                <div><label htmlFor="publication-date">Proposed publication</label><input id="publication-date" name="publicationDate" type="date" min="0001-01-01" max="9999-12-31" value={date} required aria-invalid={issue?.field === "publicationDate"} onChange={(event) => { changed(); setDate(event.target.value); }} /></div>
                <div><span className="field-label" id="market-label">Market</span><div className="market-value" aria-labelledby="market-label"><span className="market-dot" aria-hidden="true" />South Korea<span className="market-code">KR</span></div></div>
              </div>
              {issue && <p className="form-error" role="alert">{issue.message}</p>}
              <button className="submit-button" type="submit" disabled={pending}>{pending ? "Reviewing creative..." : hasReviewed ? "Review again" : "Review creative"}<span aria-hidden="true">{pending ? "..." : "\u2197"}</span></button>
            </fieldset>
            {pending && <button type="button" className="cancel-button" onClick={cancel}>Stop this review</button>}
            <p className="privacy-note">Your creative is sent to Meta when you run a review. NARAK does not save uploads or results.</p>
          </form>
        </section>
        <section className="evidence-panel" aria-labelledby="review-title" aria-busy={pending}>
          <div className="panel-heading"><h2 id="review-title" ref={resultHeading} tabIndex={-1}><span>02</span> Context review</h2><span className="panel-note">{pending ? "In progress" : response?.state === "completed" ? "Review complete" : "Evidence-led"}</span></div>
          <ReviewResultPanel response={response} pending={pending} edited={edited} />
        </section>
      </div>
      <footer className="workspace-footer"><span>Context informs judgment. People make the call.</span><span>South Korea / First review workspace</span></footer>
    </main>
  </>;
}
