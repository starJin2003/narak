import type { Assessment, ReviewInput } from "../src/lib/review-contract";

// Synthetic protocol fixtures for tests only. No application code imports these.
export const input: ReviewInput = { copy: "A quiet moment, made for you.", publicationDate: "2026-11-04", market: "KR" };
export const koreanCopy = "\uC624\uB298\uC758 \uC791\uC740 \uC990\uAC70\uC6C0";
export const researchText = "A synthetic report describes a disputed seasonal advertising interpretation. An ordinary reading is also possible.";

export function researchResponse(options: { search?: boolean; citations?: boolean; status?: string } = {}) {
  return {
    id: "resp_research_fixture", status: options.status ?? "completed",
    output: [
      { type: "reasoning", id: "reasoning_fixture", summary: [] },
      ...(options.search === false ? [] : [{
        type: "web_search_call", id: "search_fixture", status: "completed",
        action: { type: "search", query: "synthetic test query" },
        results: [{ url: "https://example.com/uncited-result", title: "Uncited fixture" }],
      }]),
      {
        type: "message", id: "message_research_fixture", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: researchText, annotations: options.citations === false ? [] : [{
          type: "url_citation", url: "https://example.com/cited-fixture", title: "Synthetic source fixture",
          start_index: 0, end_index: researchText.length, provider_extra: "preserve-this",
        }] }],
      },
    ],
  };
}

export function assessment(findings = true): Assessment {
  return {
    assessmentStatus: "complete",
    observations: [{ kind: "copy", description: "The copy describes a quiet moment." }],
    findings: findings ? [{
      title: "Synthetic seasonal context",
      observedElement: "The submitted phrase and proposed date are considered together.",
      reportedClaim: "The synthetic cited report describes disagreement about seasonal advertising.",
      reportedInterpretation: "The synthetic report attributes a contextual reading to some readers.",
      counterarguments: ["An ordinary reading remains possible."],
      modelInference: "The reported context may be relevant, but the connection needs human verification.",
      sourceIds: ["S1"],
    }] : [],
    evidenceScope: "Only the synthetic cited test material was checked.",
    limitations: ["Synthetic fixture, not a live assessment."],
  };
}

export function assessmentResponse(value: unknown = assessment()) {
  return { id: "resp_assessment_fixture", status: "completed", output: [{
    type: "message", id: "message_assessment_fixture", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: JSON.stringify(value), annotations: [] }],
  }] };
}
