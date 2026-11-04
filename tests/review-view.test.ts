import { describe, expect, it } from "vitest";
import { displayPassage, plural, sourceCounts, textLang } from "@/lib/review-view";
import type { ReviewResult } from "@/lib/review-contract";

describe("review view helpers", () => {
  it("counts cited passages, pages, sites and registry pages separately", () => {
    const source = (id: string, url: string) => ({ id, evidenceState: "unverified" as const, responseId: "r", messageId: "m", blockIndex: 0, citedPassage: "p",
      annotation: { type: "url_citation" as const, url, title: "t", start_index: 0, end_index: 1 } });
    const note = (id: string, canonicalUrl: string) => ({ id, caseId: "00000000-0000-4000-8000-000000000001", evidenceId: "00000000-0000-4000-8000-000000000002",
      sourceId: "00000000-0000-4000-8000-000000000003", caseStatus: "emerging" as const, canonicalUrl, title: "t", publisher: null, publishedOn: "2021-05-03",
      availableAt: "2021-05-03T00:00:00Z", assertionKind: "reported_fact" as const, assertionText: "a", attribution: "b", provenance: "c", relatedEvidenceId: null });
    const result = {
      sources: [source("S1", "https://www.a.example/1"), source("S2", "https://www.a.example/1"), source("S3", "https://a.example/2"), source("S4", "https://b.example/3")],
      registry: { state: "available", checkedCases: 1, matchedCaseIds: [], evidence: [note("R1", "https://c.example/x"), note("R2", "https://c.example/x"), note("R3", "https://d.example/y")] },
    } as unknown as ReviewResult;
    expect(sourceCounts(result)).toEqual({ webPassages: 4, webPages: 3, webSites: 2, registryNotes: 3, registryPages: 2 });
    expect(plural(1, "page")).toBe("1 page");
    expect(plural(1200, "passage")).toBe("1,200 passages");
  });

  it("marks only Hangul text as Korean", () => {
    expect(textLang("\uc8fc\ub9d0 \ucea0\ud551 GS25")).toBe("ko");
    expect(textLang("Night camping essentials")).toBeUndefined();
  });

  it("drops leading Markdown markers from displayed passages only", () => {
    expect(displayPassage("> GS25 faced backlash")).toBe("GS25 faced backlash");
    expect(displayPassage("- \u201csome people thought\u201d\n* second line\n2. third")).toBe("\u201csome people thought\u201d\nsecond line\nthird");
    expect(displayPassage("A -5 degree night, not a list")).toBe("A -5 degree night, not a list");
  });
});
