import { REVIEW_TIMEOUT_MS, type ReviewResponse, type ReviewResult } from "@/lib/review-contract";

function ContextMark() {
  return <svg className="context-mark" viewBox="0 0 180 134" fill="none" aria-hidden="true">
    <path d="M31 18h89v100H31z" stroke="currentColor" strokeWidth="1.2" />
    <path d="M45 38h48M45 47h60M45 56h40M45 89h31M45 98h48" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="115" cy="77" r="28" fill="var(--paper)" stroke="currentColor" strokeWidth="1.6" />
    <path d="m136 98 22 22M103 77h24M115 65v24" stroke="currentColor" strokeWidth="1.6" />
    <path d="M23 10h11M23 10v11M128 126h-11M128 126v-11" stroke="var(--accent)" strokeWidth="2" />
  </svg>;
}

function CompletedResult({ result }: { result: ReviewResult }) {
  const registryEvidence = result.registry.state === "available" ? result.registry.evidence : [];
  const labels = {
    evidence_backed_concern: "Evidence-backed concern",
    emerging_signal: "Emerging signal",
    no_supported_concern_found: "No supported concern found",
  };
  const emerging = result.outcome === "emerging_signal";
  return <div className="completed-result">
    <div className={`outcome ${emerging ? "outcome-emerging" : result.outcome === "evidence_backed_concern" ? "outcome-concern" : "outcome-neutral"}`}>
      <span className="eyebrow">{emerging ? "Verification needed" : "Within the evidence checked"}</span>
      <h3>{labels[result.outcome]}</h3>
      <p>{result.summary}</p>
    </div>
    <section className="result-section" aria-labelledby="scope-title">
      <h4 id="scope-title">Review scope</h4>
      <dl className="scope-grid">
        <div><dt>Market</dt><dd>South Korea</dd></div>
        <div><dt>Planned publication</dt><dd>{result.scope.publicationDate}</dd></div>
        <div><dt>Material checked</dt><dd>{result.scope.hasImage ? (result.scope.hasCopy ? "Image and copy" : "Image only") : "Copy only"}</dd></div>
        <div><dt>Retrieved evidence</dt><dd>{result.scope.citedSources} cited {result.scope.citedSources === 1 ? "source" : "sources"}</dd></div>
      </dl>
      <p>{result.scope.description}</p>
      <p className="small-note">{result.scope.completedSearches} completed search {result.scope.completedSearches === 1 ? "call" : "calls"}. Checked {new Date(result.scope.checkedAt).toLocaleString("en-US", { timeZoneName: "short" })}.</p>
    </section>
    {result.observations.length > 0 && <section className="result-section" aria-labelledby="observations-title">
      <h4 id="observations-title">Observed in the creative</h4>
      <ul className="observations">{result.observations.map((observation, index) => <li key={index}><span className="observation-kind">{observation.kind}</span>{observation.description}</li>)}</ul>
    </section>}
    {result.findings.map((finding, index) => <section className="finding result-section" key={index}>
      <span className="eyebrow">Signal {String(index + 1).padStart(2, "0")} / unverified</span>
      <h4>{finding.title}</h4>
      <dl className="finding-details">
        <div><dt>Creative connection</dt><dd>{finding.observedElement}</dd></div>
        <div><dt>Reported claim</dt><dd>{finding.reportedClaim}</dd></div>
        <div><dt>Reported interpretation</dt><dd>{finding.reportedInterpretation}</dd></div>
        <div><dt>Model inference</dt><dd>{finding.modelInference}</dd></div>
        <div><dt>Counterarguments and uncertainty</dt><dd>{finding.counterarguments.length ? <ul>{finding.counterarguments.map((item, i) => <li key={i}>{item}</li>)}</ul> : "No counterargument was supplied. This remains a gap for human review."}</dd></div>
      </dl>
      <div className="source-links" aria-label="Supporting source references">{finding.sourceIds.map((id) => <a href={`#source-${id}`} key={id}>Source {id} <span aria-hidden="true">&#8595;</span></a>)}</div>
    </section>)}
    <section className="result-section" aria-labelledby="sources-title">
      <h4 id="sources-title">Follow the evidence</h4>
      <p className="small-note">Provider-cited sources. Each passage below is the model&apos;s cited research text, not a quotation from the original page. Source contents still need verification.</p>
      <ol className="source-list">{result.sources.map((source) => <li id={`source-${source.id}`} key={source.id} tabIndex={-1}>
        <span className="source-number">{source.id.slice(1).padStart(2, "0")}</span>
        <div className="source-content">
          <a href={source.annotation.url} target="_blank" rel="noopener noreferrer">{source.annotation.title || new URL(source.annotation.url).hostname}<span className="sr-only"> (opens in a new tab)</span><span aria-hidden="true"> &#8599;</span></a>
          <span className="source-domain">{new URL(source.annotation.url).hostname} / Unverified</span>
          <p>{source.citedPassage}</p>
          <details><summary>Citation trace</summary><dl className="trace-details">
            <div><dt>Response</dt><dd>{source.responseId}</dd></div>
            <div><dt>Message / block</dt><dd>{source.messageId} / {source.blockIndex}</dd></div>
            <div><dt>Character span</dt><dd>{source.annotation.start_index}&ndash;{source.annotation.end_index}</dd></div>
          </dl></details>
        </div>
      </li>)}</ol>
      {registryEvidence.length > 0 && <>
        <p className="small-note">Registry references below are stored attributed notes linked to canonical sources. They are separate from Meta web citations and remain subject to human review.</p>
        <ol className="source-list">{registryEvidence.map((source) => <li id={`source-${source.id}`} key={source.id} tabIndex={-1}>
          <span className="source-number">{source.id}</span>
          <div className="source-content">
            <a href={source.canonicalUrl} target="_blank" rel="noopener noreferrer">{source.title}<span className="sr-only"> (opens in a new tab)</span><span aria-hidden="true"> &#8599;</span></a>
            <span className="source-domain">{source.publisher} / Case: {source.caseStatus} / {source.assertionKind.replaceAll("_", " ")}</span>
            <p>{source.assertionText}</p>
            <details><summary>Registry trace</summary><dl className="trace-details">
              <div><dt>Attribution</dt><dd>{source.attribution}</dd></div>
              <div><dt>Publication / availability</dt><dd>{source.publishedOn} / {source.availableAt}</dd></div>
              <div><dt>Case / evidence</dt><dd>{source.caseId} / {source.evidenceId}</dd></div>
              <div><dt>Provenance</dt><dd>{source.provenance}</dd></div>
            </dl></details>
          </div>
        </li>)}</ol>
      </>}
    </section>
    <section className="result-section limitations" aria-labelledby="limitations-title">
      <h4 id="limitations-title">What this review cannot establish</h4>
      <ul>{result.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul>
    </section>
  </div>;
}

export function ReviewResultPanel({ response, pending, edited }: {
  response: ReviewResponse | null; pending: boolean; edited: boolean;
}) {
  if (pending) return <div className="review-empty" role="status">
    <div className="loading-mark" aria-hidden="true" />
    <span className="eyebrow">Review in progress</span>
    <h3>Looking beyond the creative.</h3>
    <p>Checking the submitted material and available cultural context. A result will appear only after the evidence checks finish.</p>
    <p className="small-note">Research and assessment may take up to {Math.ceil(REVIEW_TIMEOUT_MS / 60_000)} minutes.</p>
  </div>;
  if (!response) return <div className="review-empty">
    <ContextMark />
    <span className="eyebrow">{edited ? "Ready for another look" : "Evidence before conclusions"}</span>
    <h3>{edited ? "Your creative has changed." : "Context starts here."}</h3>
    <p>{edited ? "Run a new review to check the latest image, copy, and publication date." : "Add your creative to explore what its words, imagery, and timing could mean in South Korea."}</p>
    <div className="review-principles">
      <span><b>01</b> Observe the creative</span>
      <span><b>02</b> Check available sources</span>
      <span><b>03</b> Separate reports from inference</span>
    </div>
    <p className="small-note">No review has been run for these inputs.</p>
  </div>;
  if (response.state !== "completed") return <div className={`review-problem problem-${response.state}`} role="status">
    <span className="status-symbol" aria-hidden="true">!</span>
    <span className="eyebrow">{response.state === "incomplete" ? "Evidence check incomplete" : response.state === "unavailable" ? "Service unavailable" : "Review could not finish"}</span>
    <h3>{response.state === "unavailable" ? "Live review is unavailable." : response.state === "incomplete" ? "There is not enough to conclude." : "Let’s try that again."}</h3>
    <p>{response.issue.message}</p>
    <p className="problem-boundary">No assessment was issued. An incomplete review does not mean no concern was found.</p>
  </div>;
  return <CompletedResult result={response.result} />;
}
