"use client";

import Image from "next/image";
import { REVIEW_STEPS, progressText, reviewSteps, type ReviewProgress } from "@/lib/review-progress";
import { SAMPLE_POSTERS, type SamplePoster } from "@/lib/samples";
import { formatDate } from "@/lib/review-view";

const STATE_WORDS = { idle: "", active: "In progress", done: "Done", gap: "Not available" } as const;

// How a review works, as an ordered list. On setup it explains the steps. During a review
// each step is marked from the streamed events that actually happened, nothing else.
export function ReviewSteps({ running, opened, events }: { running: boolean; opened: boolean; events: readonly ReviewProgress[] }) {
  const states = reviewSteps(running, opened, events);
  return <ol className={`steps ${running ? "live" : ""}`}>
    {REVIEW_STEPS.map((step, index) => {
      const { state, note } = states[index]!;
      return <li key={step.name} className={`step ${state}`} aria-current={state === "active" ? "step" : undefined}>
        <span className="dot" aria-hidden="true" />
        <span className="what">
          <b>{step.name}</b>
          <small>{step.by}</small>
          {(note || STATE_WORDS[state]) && <span className="note">{[STATE_WORDS[state], note].filter(Boolean).join(". ")}</span>}
        </span>
      </li>;
    })}
  </ol>;
}

// One polite, atomic status line, so each streamed stage is announced once without moving focus.
export function ReviewAnnouncer({ events }: { events: readonly ReviewProgress[] }) {
  const last = events.at(-1);
  const text = last ? progressText(last) : null;
  return <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{text ? `${text.title}. ${text.detail}` : ""}</p>;
}

export function SamplePosters({ loading, onChoose }: { loading: string | null; onChoose: (sample: SamplePoster) => void }) {
  return <section className="samples" aria-labelledby="samples-title">
    <h2 id="samples-title">Try a sample</h2>
    <ul>
      {SAMPLE_POSTERS.map((sample) => <li key={sample.id}>
        <button type="button" className="sample" onClick={() => { if (!loading) onChoose(sample); }} aria-busy={loading === sample.id} aria-disabled={Boolean(loading)}
          aria-label={`${sample.brand} sample, ${sample.title}. Runs ${formatDate(sample.date, true)}`}>
          <Image src={sample.thumb} alt="" width={120} height={150} unoptimized />
          <span className="label"><b>{sample.brand}</b><small>{formatDate(sample.date)}</small></span>
        </button>
      </li>)}
    </ul>
    <p className="fine">Choosing one fills the form. Nothing is reviewed until you press Review poster.</p>
  </section>;
}
