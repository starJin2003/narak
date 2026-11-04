import { describe, expect, it, vi } from "vitest";
import { canonicalUrl, checkRobots, citedSources, robotsAllows, runDiscovery } from "../scripts/lib/evidence-discovery.mjs";

// Synthetic fixtures only. No live provider output is stored in tests.
const text = "Publisher A reports a synthetic campaign was withdrawn. Publisher B reports a company rebuttal. Publisher C reports a later correction.";
const span = (phrase) => ({ start_index: text.indexOf(phrase), end_index: text.indexOf(phrase) + phrase.length });
function research() {
  return { id: "resp_discovery_research", status: "completed", output: [
    { type: "web_search_call", id: "ws1", status: "completed", action: { type: "search", query: "synthetic" } },
    { type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [
      { type: "url_citation", url: "https://News.example.com/a?utm_source=x#top", title: "Synthetic report A", ...span("Publisher A reports a synthetic campaign was withdrawn.") },
      { type: "url_citation", url: "https://blocked.example.org/b", title: "Synthetic report B", ...span("Publisher B reports a company rebuttal.") },
      { type: "url_citation", url: "https://late.example.net/c", title: "Synthetic report C", ...span("Publisher C reports a later correction.") },
    ] }] },
  ] };
}
const extraction = { candidates: [
  { citationId: "C1", publisher: "Publisher A", publishedOn: "2021-05-03", languageCode: "ko", assertions: [{ kind: "reported_fact", text: "The campaign was withdrawn.", attribution: "Publisher A" }] },
  { citationId: "C2", publisher: "Publisher B", publishedOn: "2021-05-04", languageCode: "ko", assertions: [{ kind: "rebuttal", text: "The company disputed the reading.", attribution: "The company, as reported by Publisher B" }] },
  { citationId: "C3", publisher: "Publisher C", publishedOn: "2026-12-01", languageCode: "en", assertions: [{ kind: "correction", text: "A later correction.", attribution: "Publisher C" }] },
  { citationId: "C1", publisher: "Publisher A", publishedOn: "", languageCode: "ko", assertions: [{ kind: "reported_interpretation", text: "Some readers saw a symbol.", attribution: "Readers quoted by Publisher A" }] },
] };
const message = (value) => ({ id: "resp_discovery_extraction", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }] });

function fetcher(overrides = {}) {
  return vi.fn(async (url, init) => {
    const target = String(url);
    if (target.endsWith("/robots.txt")) {
      if (target.startsWith("https://blocked.example.org")) return new Response("User-agent: meta-externalagent\nDisallow: /\n");
      return new Response("User-agent: *\nDisallow: /private\n");
    }
    const body = JSON.parse(String(init.body));
    return Response.json(body.tools ? (overrides.research ?? research()) : message(overrides.extraction ?? extraction));
  });
}

describe("discovery helpers", () => {
  it("keeps the publisher path and strips only fragments and tracking tags", () => {
    expect(canonicalUrl("https://News.example.com/a/b?id=7&utm_medium=x#top")).toBe("https://news.example.com/a/b?id=7");
    expect(canonicalUrl("ftp://example.com/a")).toBeNull();
    expect(canonicalUrl("https://user:pw@example.com/a")).toBeNull();
  });

  it("applies robots rules for Meta agents with longest match and allow on a tie", () => {
    const rules = "User-agent: *\nDisallow: /news\nAllow: /news/public\n\nUser-agent: facebookbot\nDisallow: /archive$\n";
    expect(robotsAllows(rules, "/news/public/1")).toBe(true);
    expect(robotsAllows(rules, "/news/2")).toBe(false);
    expect(robotsAllows(rules, "/archive")).toBe(false);
    // "$" anchors the rule, and a specific group replaces the generic one for that agent.
    expect(robotsAllows(rules, "/archive/1")).toBe(true);
    expect(robotsAllows("User-agent: meta-externalagent\nUser-agent: other\nDisallow: /\n", "/a")).toBe(false);
    expect(robotsAllows("", "/a")).toBe(true);
  });

  it("follows RFC 9309 for missing and unreachable robots files", async () => {
    const signal = new AbortController().signal;
    expect(await checkRobots("https://a.example/x", vi.fn(async () => new Response("", { status: 404 })), signal)).toBe("no_robots_file");
    expect(await checkRobots("https://a.example/x", vi.fn(async () => new Response("", { status: 503 })), signal)).toBe("unreachable");
    expect(await checkRobots("https://a.example/x", vi.fn(async () => { throw new TypeError("network"); }), signal)).toBe("unreachable");
  });

  it("accepts only provider annotations as sources", () => {
    const raw = research();
    raw.output[1].content[0].text += " See https://invented.example.com/page.";
    const { sources, searches } = citedSources(raw);
    expect(searches).toBe(1);
    expect(sources.map((source) => source.url)).toEqual(["https://news.example.com/a", "https://blocked.example.org/b", "https://late.example.net/c"]);
  });

  it("reads citation offsets as Unicode code points, matching the review parser", () => {
    // Two astral characters before the cited sentence shift UTF-16 offsets by two.
    const prefix = "\u{1F3D5}\u{1F319} ";
    const sentence = "Publisher A reports a synthetic campaign was withdrawn.";
    const body = `${prefix}${sentence}`;
    const start = Array.from(prefix).length;
    const raw = { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: body, annotations: [
      { type: "url_citation", url: "https://news.example.com/a", title: "A", start_index: start, end_index: start + Array.from(sentence).length },
    ] }] }] };
    expect(citedSources(raw).sources[0].passages).toEqual([sentence]);
    // An end offset that only fits UTF-16 length is out of range in code points and is dropped.
    raw.output[0].content[0].annotations[0].end_index = body.length;
    expect(citedSources(raw).sources).toEqual([]);
  });
});

describe("discovery run", () => {
  it("stages emerging candidates with attribution and excludes restricted, late and duplicate sources", async () => {
    const run = await runDiscovery({ topic: { query: "synthetic campaign", before: "2026-11-20", caseKey: null }, key: "k", fetcher: fetcher(), registryUrls: new Set() });
    expect(run).toMatchObject({ reviewState: "emerging", humanReviewed: false, registryChecked: true, completedSearches: 1 });
    expect(run.candidates).toHaveLength(1);
    const [candidate] = run.candidates;
    expect(candidate).toMatchObject({
      canonicalUrl: "https://news.example.com/a", discoveryMethod: "meta_web_search", storageRights: "metadata_only",
      reviewState: "emerging", humanReviewed: false, providerResponseId: "resp_discovery_research", robots: "allowed",
    });
    expect(candidate.assertions[0]).toMatchObject({ kind: "reported_fact", attribution: "Publisher A", modelId: "muse-spark-1.3" });
    expect(candidate.citedResearch.label).toContain("Not a quotation");
    expect(run.excluded.map((item) => item.reason)).toEqual(["publisher_restricts_meta_agents", "published_on_or_after_cutoff", "duplicate_in_batch"]);
    expect(JSON.stringify(run)).not.toContain('"verified"');
  });

  it("removes sources already in the registry or already staged", async () => {
    const run = await runDiscovery({ topic: { query: "synthetic campaign", before: "2026-11-20", caseKey: null }, key: "k", fetcher: fetcher(),
      registryUrls: new Set(["https://news.example.com/a"]), stagedUrls: new Set(["https://late.example.net/c"]) });
    expect(run.candidates).toEqual([]);
    expect(run.excluded.map((item) => item.reason)).toEqual(["already_in_registry", "publisher_restricts_meta_agents", "already_staged", "duplicate_in_batch"]);
    const unchecked = await runDiscovery({ topic: { query: "synthetic campaign", before: "2026-11-20", caseKey: null }, key: "k", fetcher: fetcher() });
    expect(unchecked.registryChecked).toBe(false);
    expect(unchecked.gaps.join(" ")).toContain("not checked for duplicates");
  });

  it("stops on unfinished research, a written URL or an unknown citation shape", async () => {
    const topic = { query: "synthetic campaign", before: "2026-11-20", caseKey: null };
    const unfinished = research(); unfinished.output[0].status = "searching";
    await expect(runDiscovery({ topic, key: "k", fetcher: fetcher({ research: unfinished }) })).rejects.toThrow();
    const withUrl = structuredClone(extraction); withUrl.candidates[0].assertions[0].text = "See www.example.com";
    await expect(runDiscovery({ topic, key: "k", fetcher: fetcher({ extraction: withUrl }) })).rejects.toThrow();
    const verified = structuredClone(extraction); verified.candidates[0].status = "verified";
    await expect(runDiscovery({ topic, key: "k", fetcher: fetcher({ extraction: verified }) })).rejects.toThrow();
  });
});
