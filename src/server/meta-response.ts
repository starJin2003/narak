import "server-only";
import { z } from "zod";
import {
  citationAnnotationSchema, searchCallSchema, type ReviewSource, type SearchCall,
} from "@/lib/review-contract";
import { incomplete, invalidResponse } from "./review-error";

const envelopeSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["completed", "incomplete", "failed", "cancelled", "in_progress", "queued"]),
  output: z.array(z.unknown()).max(200),
});

const itemSchema = z.object({ type: z.string() }).passthrough();
const messageSchema = z.object({
  type: z.literal("message"),
  id: z.string(),
  role: z.literal("assistant"),
  status: z.literal("completed"),
  phase: z.string().nullish(),
  content: z.array(z.unknown()).max(100),
});
const textBlockSchema = z.object({
  type: z.literal("output_text"),
  text: z.string().max(60_000),
  annotations: z.array(z.unknown()).max(100).default([]),
});

export function parseMetaResponse(raw: unknown) {
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) throw invalidResponse();
  if (parsed.data.status !== "completed") {
    throw incomplete("assessment_incomplete", "The review service did not finish its response. No assessment was issued.");
  }
  const searchCalls: SearchCall[] = [];
  const sources: ReviewSource[] = [];
  const textBlocks: string[] = [];
  let rejectedCitations = 0;

  for (const rawItem of parsed.data.output) {
    const item = itemSchema.safeParse(rawItem);
    if (!item.success) throw invalidResponse();
    if (item.data.type === "web_search_call") {
      const call = searchCallSchema.safeParse(rawItem);
      if (!call.success) throw invalidResponse();
      searchCalls.push(call.data);
    } else if (item.data.type === "message") {
      const message = messageSchema.safeParse(rawItem);
      if (!message.success) throw invalidResponse();
      if (message.data.phase === "commentary") continue;
      for (const [blockIndex, content] of message.data.content.entries()) {
        const type = itemSchema.safeParse(content);
        if (type.success && type.data.type === "refusal") {
          throw incomplete("assessment_incomplete", "The review service could not assess this creative. No assessment was issued.");
        }
        const block = textBlockSchema.safeParse(content);
        if (!block.success) throw invalidResponse();
        textBlocks.push(block.data.text);
        // Meta documents character offsets using Python string slicing.
        const characters = Array.from(block.data.text);
        for (const annotation of block.data.annotations) {
          const annotationType = itemSchema.safeParse(annotation);
          if (!annotationType.success || annotationType.data.type !== "url_citation") continue;
          const citation = citationAnnotationSchema.safeParse(annotation);
          if (!citation.success || citation.data.end_index > characters.length || citation.data.start_index >= citation.data.end_index) {
            rejectedCitations += 1;
            continue;
          }
          const citedPassage = characters.slice(citation.data.start_index, citation.data.end_index).join("");
          if (!citedPassage.trim() || citedPassage.length > 30_000) {
            rejectedCitations += 1;
            continue;
          }
          sources.push({
            id: `S${sources.length + 1}`,
            evidenceState: "unverified",
            responseId: parsed.data.id,
            messageId: message.data.id,
            blockIndex,
            annotation: citation.data,
            citedPassage,
          });
        }
      }
    } else if (item.data.type !== "reasoning") {
      // Unexpected tool calls cannot silently become completed assessments.
      throw invalidResponse();
    }
  }
  if (!textBlocks.length) throw invalidResponse();
  if (sources.length > 40 || textBlocks.join("\n").length > 60_000) throw invalidResponse();
  return { responseId: parsed.data.id, searchCalls, sources, textBlocks, rejectedCitations };
}
