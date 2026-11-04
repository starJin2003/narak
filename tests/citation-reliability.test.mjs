import { describe, expect, it, vi } from "vitest";
import { reviewWithMeta } from "@/server/meta";
import { parseMetaResponse } from "@/server/meta-response";
import { createReviewDiagnostics, providerMetadata } from "@/server/review-diagnostics";
import { createLogSummary } from "../scripts/review-logs.mjs";
import { input, researchResponse, assessmentResponse, researchText } from "./fixtures";

// retryRaw is the reply to the one research retry that follows missing citations.
async function review(raw, registry = { state: "available", checkedCases: 0, matchedCaseIds: [], evidence: [] }, retryRaw = null) {
  const lines = [], diagnostics = createReviewDiagnostics((line) => lines.push(line));
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(raw));
  if (retryRaw) fetcher.mockResolvedValueOnce(Response.json(retryRaw));
  fetcher.mockResolvedValueOnce(Response.json(assessmentResponse()));
  const registryRetriever = vi.fn().mockResolvedValue(registry);
  const response = await reviewWithMeta(input, { apiKey: "synthetic-test-key", fetcher, registryRetriever, diagnostics });
  diagnostics.finish(response);
  return { response, fetcher, registryRetriever, events: lines.map((line) => JSON.parse(line)), lines };
}
function message(raw) { return raw.output.find((item) => item.type === "message"); }

describe("production citation reliability boundaries", () => {
  it("reproduces eight completed searches with zero annotations, retries once and stops before registry or assessment", async () => {
    const raw = researchResponse({ citations: false });
    const search = raw.output.find((item) => item.type === "web_search_call");
    raw.output = [...Array.from({ length: 8 }, (_, index) => ({ ...search, id: `search_${index}` })), message(raw)];
    message(raw).phase = "final_answer";
    const value = await review(raw, undefined, raw);
    expect(value.response).toMatchObject({ state: "incomplete", issue: { code: "insufficient_sources" } });
    expect(value.events.find((event) => event.event === "provider_finished")).toMatchObject({ providerStatus: "completed", searches: { completed: 8 }, citationAnnotations: 0, acceptedSources: 0, messages: { final: 1, commentary: 0, commentaryCitations: 0 } });
    expect(value.events.at(-1).category).toBe("missing_citations");
    expect(value.events.filter((event) => event.event === "research_retried")).toEqual([expect.objectContaining({ reason: "missing_citations" })]);
    expect(value.fetcher).toHaveBeenCalledTimes(2); expect(value.registryRetriever).not.toHaveBeenCalled();
  });
  it("keeps commentary-only citations separate from a citation-free final answer", async () => {
    const raw = researchResponse(); const commentary = message(raw); commentary.phase = "commentary";
    raw.output.push({ ...commentary, id: "final_message", phase: "final_answer", content: [{ type: "output_text", text: "<creative_observations>[]</creative_observations>", annotations: [] }] });
    const value = await review(raw, undefined, raw);
    expect(value.response.state).toBe("incomplete"); expect(value.events.at(-1).category).toBe("missing_citations");
    const summary = createLogSummary(); for (const line of value.lines) summary.addLine(line);
    expect(summary.result().reviews[0].stages.research.messages).toEqual({ final: 1, commentary: 1, unknownPhase: 0, commentaryCitations: 1 });
    expect(parseMetaResponse(raw).sources).toEqual([]);
  });
  it.each(["final_answer", null, undefined])("accepts valid native annotations in documented or legacy phase %s", async (phase) => {
    const raw = researchResponse(); message(raw).phase = phase;
    const parsed = parseMetaResponse(raw);
    expect(parsed.sources[0]).toMatchObject({ messageId: "message_research_fixture", annotation: { url: "https://example.com/cited-fixture", provider_extra: "preserve-this" }, citedPassage: researchText });
    const value = await review(raw); expect(value.response.state).toBe("completed"); expect(value.fetcher).toHaveBeenCalledTimes(2);
    const prompt = JSON.parse(value.fetcher.mock.calls[0][1].body).instructions;
    expect(prompt).toContain("native inline citations in your final answer");
    expect(prompt).toContain("must not replace the research narrative");
  });
  it("collects annotated final blocks across messages without accepting commentary or relying on the last item", () => {
    const raw = researchResponse(); const first = message(raw); first.phase = "final_answer";
    raw.output.push({ ...first, id: "another_final", content: [first.content[0], first.content[0]] });
    raw.output.push({ ...first, id: "late_commentary", phase: "commentary" });
    expect(parseMetaResponse(raw).sources.map((source) => [source.messageId, source.blockIndex])).toEqual([[first.id,0],["another_final",0],["another_final",1]]);
  });
  it.each(["unknown_phase", "wrong_text_type", "annotations_as_string", "missing_message_trace", "unexpected_tool"])("rejects unexpected structure: %s", (kind) => {
    const raw = researchResponse(); const final = message(raw);
    if (kind === "unknown_phase") final.phase = "PRIVATE-UNRECOGNIZED-PHASE";
    if (kind === "wrong_text_type") final.content[0].type = "text";
    if (kind === "annotations_as_string") final.content[0].annotations = "PRIVATE-BAD-ANNOTATIONS";
    if (kind === "missing_message_trace") delete final.id;
    if (kind === "unexpected_tool") raw.output.push({ type: "function_call", id: "unexpected" });
    expect(() => parseMetaResponse(raw)).toThrow();
    if (kind === "unknown_phase") expect(providerMetadata(raw)).toMatchObject({ messages: { unknownPhase: 1, final: 0 } });
    expect(JSON.stringify(providerMetadata(raw))).not.toContain("PRIVATE-");
  });
  it("never manufactures annotations from result hits, prose URLs, top-level citations or nested unsupported citation objects", () => {
    const raw = researchResponse({ citations: false }); const block = message(raw).content[0];
    block.text = "An ungrounded claim: https://example.com/not-annotated";
    raw.citations = [{ url: "https://example.com/top-level" }];
    expect(parseMetaResponse(raw).sources).toEqual([]);
    block.annotations = [{ type: "url_citation", url_citation: { url: "https://example.com/nested", title: "Unsupported", start_index: 0, end_index: 2 } }];
    expect(parseMetaResponse(raw)).toMatchObject({ sources: [], rejectedCitations: 1 });
  });
  it("exposes only the bounded registry error code in diagnostics and offline summaries", async () => {
    const value = await review(researchResponse(), { state: "unavailable", code: "invalid_configuration" });
    expect(value.response.state).toBe("completed"); // Existing supported emerging result with coverage gap.
    expect(value.events.find((event) => event.event === "registry_checked")).toMatchObject({ state: "unavailable", code: "invalid_configuration" });
    const summary = createLogSummary(); for (const line of value.lines) summary.addLine(line);
    expect(summary.result().reviews[0].registry).toEqual([{ state: "unavailable", selectedCases: null, code: "invalid_configuration" }]);
  });
});
