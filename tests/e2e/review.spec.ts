import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import sharp from "sharp";
import type { ReviewResponse, ReviewResult } from "../../src/lib/review-contract";
import { MAX_IMAGE_BYTES } from "../../src/lib/review-contract";
import type { VariantResponse } from "../../src/lib/variant-contract";
import { assessment, koreanCopy, researchText } from "../fixtures";

// Every response below is a labeled synthetic fixture for browser checks. No live output.
const W = 400, H = 500;
const box = { left: 40, top: 300, right: 200, bottom: 460 };
const posterBytes = () => sharp({ create: { width: W, height: H, channels: 3, background: "#1a3a4a" } })
  .composite([{ input: { create: { width: 160, height: 160, channels: 3, background: "#e0b090" } }, left: 40, top: 300 }]).png().toBuffer();

function fixtureResult(publicationDate: string, options: { image?: boolean; regions?: boolean } = {}): ReviewResponse {
  const data = assessment();
  const findings = data.findings.map((finding) => ({ ...finding, visualConcept: options.image ? "hand" : null }));
  if (options.image) findings.push({ ...findings[0]!, title: "TEST FIXTURE: Copy only finding", visualConcept: null });
  const result: ReviewResult = {
    outcome: "emerging_signal", summary: "TEST FIXTURE: An unverified signal for browser validation only.",
    observations: data.observations, findings, verifiedCaseIds: [],
    limitations: ["TEST FIXTURE: No live research was performed."],
    searchCalls: [{ id: "search_fixture", status: "completed" }],
    sources: [{
      id: "S1", evidenceState: "unverified", responseId: "response_fixture", messageId: "message_fixture", blockIndex: 0,
      citedPassage: researchText,
      annotation: { type: "url_citation", url: "https://example.com/cited-fixture", title: "Synthetic source fixture", start_index: 0, end_index: researchText.length },
    }],
    registry: { state: "available", checkedCases: 0, matchedCaseIds: [], evidence: [], gaps: [] },
    scope: { market: "KR", publicationDate, checkedAt: "2026-11-03T12:00:00Z", hasImage: Boolean(options.image), hasCopy: true, completedSearches: 1, citedSources: 1, description: "Synthetic browser fixture only." },
    segmentation: options.image ? {
      state: "completed", reason: null, model: "sam-3.1", image: { width: W, height: H },
      concepts: [{ concept: "hand", findingIndexes: [0], status: options.regions === false ? "not_found" : "found", regionIds: options.regions === false ? [] : ["G1"] }],
      regions: options.regions === false ? [] : [{ id: "G1", concept: "hand", findingIndexes: [0], box, confidence: null, matchesForConcept: 1,
        mask: { path: "M0 0h160v160h-160z", x: box.left, y: box.top, scaleX: 1, scaleY: 1 } }],
    } : { state: "not_requested", reason: "no_image", model: null, image: null, concepts: [], regions: [] },
    variantContext: options.image && options.regions !== false ? "TEST-FIXTURE-CONTEXT" : null,
  };
  return { state: "completed", result };
}

async function fixtureVariant(options: { drift?: boolean } = {}): Promise<VariantResponse> {
  const variant = await sharp({ create: { width: W, height: H, channels: 3, background: "#1a3a4a" } }).png().toBuffer();
  return { state: "completed", result: {
    model: "muse-image-1.0", image: { dataUrl: `data:image/png;base64,${variant.toString("base64")}`, width: W, height: H },
    transfer: { format: "png", width: W, height: H, bytes: variant.byteLength },
    firstReview: { outcome: options.drift ? "no_supported_concern_found" : "emerging_signal", findings: options.drift ? 0 : 1 },
    originalMatchesFirstReview: !options.drift,
    returnedSize: { width: W, height: H }, target: { regionId: "G1", concept: "hand", box }, instruction: "Replace it with a paper cup",
    preservation: { outsideChangedShare: 0.02, insideChangedShare: 0.8, changedCells: [{ left: 300, top: 0, right: 330, bottom: 24 }], cellsTruncated: false, material: false, targetChanged: true },
    redetection: { status: "not_found", regions: [], targetStillDetected: false, otherMatches: 0, otherMatchesMissing: 0 },
    original: { state: "completed", outcome: "emerging_signal", findings: [{ ...assessment().findings[0]!, visualConcept: "hand" }], evidenceScope: "TEST FIXTURE", limitations: [] },
    variant: { state: "completed", outcome: "no_supported_concern_found", findings: [], evidenceScope: "TEST FIXTURE", limitations: [] },
    notes: ["TEST FIXTURE: The variant is a synthetic image made for this comparison."],
  } };
}

async function noViolations(page: Page) {
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
}
async function noOverflow(page: Page) {
  const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth }));
  expect(size.scroll).toBeLessThanOrEqual(size.viewport);
}
// The optional copy field is always open on setup.
const copyField = (page: Page) => page.getByLabel("Ad copy", { exact: true });
async function openCopy(page: Page) {
  await expect(copyField(page)).toBeVisible();
}
async function fillCopyReview(page: Page) {
  await openCopy(page);
  await copyField(page).fill(koreanCopy);
  await page.getByLabel("Runs on").fill("2026-11-04");
}
async function fillPosterReview(page: Page) {
  await page.getByLabel("Poster image").setInputFiles({ name: "test-poster.png", mimeType: "image/png", buffer: await posterBytes() });
  await expect(page.getByAltText("Poster under review, test-poster.png")).toBeVisible();
  await openCopy(page);
  await copyField(page).fill(koreanCopy);
  await page.getByLabel("Runs on").fill("2026-11-04");
}
// The edit control sits with the result's links in the left column.
const editButton = (page: Page) => page.getByRole("button", { name: /^Edit (poster|copy) or date$/ });

test("pages carry a nonce-based content security policy that the app never violates", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (message) => { if (/Content Security Policy|Refused to/i.test(message.text())) violations.push(message.text()); });
  const response = await page.goto("/");
  const policy = response!.headers()["content-security-policy"] ?? "";
  const nonce = /'nonce-([^']+)'/.exec(policy)?.[1];
  expect(nonce).toBeTruthy();
  expect(policy).toContain("frame-ancestors 'none'");
  expect(response!.headers()["permissions-policy"]).toContain("camera=()");
  // Every script the server renders carries this request's nonce. Chunks those scripts
  // insert later are allowed by 'strict-dynamic' and need none.
  const scripts = [...(await response!.text()).matchAll(/<script\b[^>]*>/g)].map((match) => match[0]);
  expect(scripts.length).toBeGreaterThan(0);
  expect(scripts.every((tag) => tag.includes(`nonce="${nonce}"`))).toBe(true);
  await page.getByLabel("Poster image").setInputFiles({ name: "test-poster.png", mimeType: "image/png", buffer: await posterBytes() });
  await expect(page.getByAltText("Poster under review, test-poster.png")).toBeVisible();
  expect(violations).toEqual([]);
});

test("empty workspace is responsive, keyboard accessible, and has no automated accessibility violations", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page).toHaveTitle("NARAK | Poster review");
  await expect(page.getByRole("heading", { name: "Check a poster before it runs" })).toBeVisible();
  await expect(page.getByText("Explore how your poster could be interpreted")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to the poster" })).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Poster image")).toBeFocused();
  await noOverflow(page);
  await noViolations(page);
  await page.screenshot({ path: testInfo.outputPath("workspace.png"), fullPage: true });
});

test("validates missing inputs and preserves Korean copy through a real unavailable response", async ({ page }) => {
  await page.goto("/");
  // The action stays focusable while aria-disabled, so a click explains what is missing.
  await page.getByRole("button", { name: "Review poster" }).click({ force: true });
  await expect(page.locator("#file-error")).toHaveText("Add a poster or ad copy to review.");
  await openCopy(page);
  await copyField(page).fill(koreanCopy);
  await page.getByRole("button", { name: "Review copy" }).click({ force: true });
  await expect(page.locator("#date-error")).toHaveText("Choose the date this runs.");
  await expect(page.getByLabel("Runs on")).toBeFocused();
  await page.getByLabel("Runs on").fill("2026-11-04");
  const response = page.waitForResponse("**/api/review");
  await page.getByRole("button", { name: "Review copy" }).click();
  expect((await response).status()).toBe(503);
  await expect(page.getByRole("heading", { name: "Live review unavailable" })).toBeVisible();
  await expect(page.getByText("never a sign that the creative is clear", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No supported concern found", exact: true })).toHaveCount(0);
  await noViolations(page);
  await page.getByRole("button", { name: "Edit the creative", exact: true }).click();
  await expect(copyField(page)).toHaveValue(koreanCopy);
});

test("shows a valid poster and rejects unsupported, large, and corrupt files", async ({ page }) => {
  await page.goto("/");
  const fileInput = page.getByLabel("Poster image");
  await fileInput.setInputFiles({ name: "unsupported.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg/>") });
  await expect(page.locator("#file-error")).toHaveText("Use a JPEG, PNG or WebP image.");
  await fileInput.setInputFiles({ name: "large.png", mimeType: "image/png", buffer: Buffer.alloc(MAX_IMAGE_BYTES + 1) });
  await expect(page.locator("#file-error")).toHaveText("Use an image of 4 MB or less.");
  await fileInput.setInputFiles({ name: "corrupt.png", mimeType: "image/png", buffer: Buffer.from("not an image") });
  await expect(page.locator("#file-error")).toContainText("could not be read");
  await fileInput.setInputFiles({ name: "original-test-creative.png", mimeType: "image/png", buffer: await posterBytes() });
  const preview = page.getByAltText("Poster under review, original-test-creative.png");
  await expect(preview).toBeVisible();
  expect(await preview.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(W);
  await page.getByRole("button", { name: "Remove" }).click();
  await expect(preview).toHaveCount(0);
  await expect(page.getByText("Drop a poster")).toBeVisible();
});

test("draws SAM regions on the poster in the right place and opens the linked evidence", async ({ page }, testInfo) => {
  const submissions: Array<{ copy: string; date: string; image: boolean }> = [];
  let release: (() => void) | undefined;
  const waitForRelease = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/review", async (route) => {
    const request = route.request();
    const form = await new Response(new Uint8Array(request.postDataBuffer()!), { headers: { "content-type": request.headers()["content-type"]! } }).formData();
    const date = String(form.get("publicationDate"));
    submissions.push({ copy: String(form.get("copy")), date, image: form.get("image") instanceof File });
    if (submissions.length === 1) await waitForRelease;
    await route.fulfill({ json: fixtureResult(date, { image: true }) });
  });
  await page.goto("/");
  await fillPosterReview(page);
  await page.getByRole("button", { name: "Review poster" }).click();
  await expect(page.getByRole("heading", { name: "Reviewing the poster" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel review" })).toBeVisible();
  release!();
  await expect(page.getByRole("heading", { name: "Emerging signal", exact: true })).toBeVisible();
  // The region box (40, 300) to (200, 460) on a 400 by 500 image maps to percentages of the frame.
  const reticle = page.locator(".reticle");
  await expect(reticle).toHaveCount(1);
  expect(await reticle.evaluate((element) => [element.style.left, element.style.top, element.style.width, element.style.height])).toEqual(["10%", "60%", "40%", "32%"]);
  await expect(page.locator(".overlay .mask")).toHaveAttribute("transform", "translate(40 300) scale(1 1)");
  const marker = page.getByRole("button", { name: "hand, finding 1" });
  await expect(marker).toHaveAttribute("aria-current", "true");
  await expect(page.locator(".lens")).toContainText("SAM 3.1 outlined one area matching \"hand\"");
  await noViolations(page);
  await page.screenshot({ path: testInfo.outputPath("poster-result.png"), fullPage: true });
  // Wide screens step with the arrows under the poster; phones keep them in the lens sheet.
  await page.getByRole("button", { name: "Next finding" }).filter({ visible: true }).first().click();
  await expect(page.locator(".lens")).toContainText("TEST FIXTURE: Copy only finding");
  await expect(page.locator(".lens")).toContainText("ties this finding to the copy or the date");
  await expect(page.locator(".reticle")).toHaveCount(0);
  await marker.click();
  await expect(page.locator(".lens")).toContainText("Finding 1 of 2");
  await page.locator(".lens").getByRole("button", { name: "Evidence" }).click();
  await expect(page.locator("#ev-title")).toBeFocused();
  await expect(page.locator(".evidence").getByRole("link", { name: /example\.com/ })).toHaveAttribute("href", "https://example.com/cited-fixture");
  await expect(page.locator(".evidence .src", { hasText: "example.com" })).toContainText("Synthetic source fixture");
  await expect(page.locator(".evidence figcaption")).toHaveText("Outline by SAM 3.1");
  await page.locator(".evidence").getByText("Original text and citation trace", { exact: true }).click();
  await expect(page.getByText("response_fixture", { exact: true })).toBeVisible();
  await noViolations(page);
  await page.keyboard.press("Escape");
  await expect(page.locator(".evidence")).not.toHaveClass(/open/);
  await editButton(page).click();
  // Editing moves focus to the date field on the next tick. Waiting for it keeps the fill below
  // from racing that focus change, and checks the focus handoff itself.
  await expect(page.getByLabel("Runs on")).toBeFocused();
  await copyField(page).fill(`${koreanCopy} revised`);
  await page.getByLabel("Runs on").fill("2026-12-12");
  await page.getByRole("button", { name: "Review again" }).click();
  await expect(page.getByRole("heading", { name: "Emerging signal", exact: true })).toBeVisible();
  expect(submissions).toEqual([{ copy: koreanCopy, date: "2026-11-04", image: true }, { copy: `${koreanCopy} revised`, date: "2026-12-12", image: true }]);
  await noOverflow(page);
});

test("keeps the assessment when SAM found no area and never draws a guessed region", async ({ page }) => {
  await page.route("**/api/review", (route) => route.fulfill({ json: fixtureResult("2026-11-04", { image: true, regions: false }) }));
  await page.goto("/");
  await fillPosterReview(page);
  await page.getByRole("button", { name: "Review poster" }).click();
  await expect(page.getByRole("heading", { name: "Emerging signal", exact: true })).toBeVisible();
  await expect(page.locator(".mk, .reticle, .overlay")).toHaveCount(0);
  await expect(page.locator(".lens")).toContainText("SAM 3.1 found no area matching \"hand\"");
  await expect(page.getByRole("button", { name: "Test a variant" })).toHaveCount(0);
});

test("a copy only review shows the copy card, findings and sources without regions", async ({ page }) => {
  await page.route("**/api/review", (route) => route.fulfill({ json: fixtureResult("2026-11-04") }));
  await page.goto("/");
  await fillCopyReview(page);
  await page.getByRole("button", { name: "Review copy" }).click();
  await expect(page.getByRole("heading", { name: "Emerging signal", exact: true })).toBeVisible();
  await expect(page.locator(".copy-card")).toContainText(koreanCopy);
  await expect(page.locator(".mk, .reticle")).toHaveCount(0);
  await expect(page.locator(".lens")).toContainText("Synthetic seasonal context");
  await page.locator(".lens").getByRole("button", { name: "Evidence" }).click();
  await expect(page.locator(".evidence .crop")).toHaveCount(0);
  await expect(page.locator(".evidence").getByText("Region outline")).toHaveCount(0);
  await noViolations(page);
});

test("incomplete retrieval cannot appear as a successful negative review", async ({ page }) => {
  await page.route("**/api/review", (route) => route.fulfill({ json: {
    state: "incomplete", result: null, issue: { code: "insufficient_sources", message: "TEST FIXTURE: No usable source annotations were returned.", retryable: true },
  } }));
  await page.goto("/");
  await fillCopyReview(page);
  await page.getByRole("button", { name: "Review copy" }).click();
  await expect(page.getByRole("heading", { name: "Review incomplete" })).toBeVisible();
  await expect(page.getByText("Nothing was assessed, so nothing on the poster is marked.", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No supported concern found", exact: true })).toHaveCount(0);
});

test("registry references remain distinct from provider citations and keep their attribution", async ({ page }, testInfo) => {
  const response = fixtureResult("2026-11-04");
  if (response.state !== "completed") throw new Error("Expected fixture result");
  response.result.findings[0]!.sourceIds = ["S1", "R1"];
  response.result.registry = {
    state: "available", checkedCases: 1, matchedCaseIds: ["00000000-0000-4000-8000-000000000001"], gaps: [],
    evidence: [{
      id: "R1", caseId: "00000000-0000-4000-8000-000000000001", evidenceId: "00000000-0000-4000-8000-000000000002",
      sourceId: "00000000-0000-4000-8000-000000000003", caseStatus: "emerging", canonicalUrl: "https://example.com/registry-fixture",
      title: "Synthetic registry fixture", publisher: "Synthetic publisher", publishedOn: "2023-11-30", availableAt: "2023-11-30T10:37:49Z",
      assertionKind: "correction", assertionText: "TEST FIXTURE: Original attributed correction note.", attribution: "Synthetic reporting only",
      provenance: "TEST FIXTURE: Secondary reporting, not independent verification.", relatedEvidenceId: "00000000-0000-4000-8000-000000000004",
    }],
  };
  await page.route("**/api/review", (route) => route.fulfill({ json: response }));
  await page.goto("/"); await fillCopyReview(page); await page.getByRole("button", { name: "Review copy" }).click();
  // Every finding has the same basis as the outcome, so no label repeats the heading. The
  // basis note still names it.
  await expect(page.locator(".lens .pill")).toHaveCount(0);
  await expect(page.locator(".lens")).toContainText("Backed by a documented case that no person has verified yet.");
  await page.locator(".lens").getByRole("button", { name: "Evidence" }).click();
  // The registry note keeps its own kind, publisher and attribution, apart from the web citation.
  const note = page.locator(".evidence .voice", { hasText: "TEST FIXTURE: Original attributed correction note." });
  await expect(note).toContainText("Correction");
  await expect(note).toContainText("Synthetic publisher");
  await expect(note).not.toContainText("R1");
  await expect(note).toContainText("Synthetic reporting only, 30 Nov 2023");
  await expect(note).toHaveClass(/against/);
  const record = page.locator(".evidence .src", { hasText: "Synthetic registry fixture" });
  await expect(record).toContainText("Emerging case");
  await expect(record).not.toContainText("Character span");
  await expect(page.locator(".evidence .group-label").first()).toHaveText("Web pages cited by Muse Spark. No person has verified them.");
  await expect(page.locator(".evidence")).not.toContainText("Unverified web citation");
  // The source trail names publishers and hosts, never internal S or R identifiers.
  await expect(page.locator(".evidence .voice .k")).not.toContainText([/\b[SR][0-9]+\b/]);
  await record.getByText("Registry record", { exact: true }).click();
  await expect(page.getByText("TEST FIXTURE: Secondary reporting, not independent verification.")).toBeVisible();
  await noOverflow(page);
  await noViolations(page);
  await page.screenshot({ path: testInfo.outputPath("registry-result.png"), fullPage: true });
});

test("cancellation restores editing and ignores a late response", async ({ page }) => {
  let release: (() => void) | undefined;
  const waitForRelease = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/review", async (route) => { await waitForRelease; await route.fulfill({ json: fixtureResult("2026-11-04") }); });
  await page.goto("/");
  await fillCopyReview(page);
  await page.getByRole("button", { name: "Review copy" }).click();
  await page.getByRole("button", { name: "Cancel review" }).click();
  release!();
  await expect(page.getByText("You stopped this review before it finished.", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Emerging signal", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Edit the creative", exact: true }).click();
  await expect(copyField(page)).toBeEnabled();
  await expect(copyField(page)).toHaveValue(koreanCopy);
});

test("network errors and reduced motion are handled", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/review", (route) => route.abort());
  await page.goto("/");
  await fillCopyReview(page);
  await page.getByRole("button", { name: "Review copy" }).click();
  await expect(page.getByRole("heading", { name: "Live review unavailable" })).toBeVisible();
  await expect(page.getByText("The review could not be reached.", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
});

test("a controlled variant is labeled as generated and compared with the original", async ({ page }, testInfo) => {
  const warnings: string[] = [];
  page.on("console", (message) => { if (["warning", "error"].includes(message.type())) warnings.push(message.text()); });
  const variantForms: Array<Record<string, string>> = [];
  let variantCalls = 0;
  await page.route("**/api/review", (route) => route.fulfill({ json: fixtureResult("2026-11-04", { image: true }) }));
  await page.route("**/api/variant", async (route) => {
    const request = route.request();
    const form = await new Response(new Uint8Array(request.postDataBuffer()!), { headers: { "content-type": request.headers()["content-type"]! } }).formData();
    variantForms.push(Object.fromEntries([...form.entries()].filter(([, value]) => typeof value === "string")) as Record<string, string>);
    variantCalls += 1;
    if (variantCalls === 1) {
      await route.fulfill({ status: 422, json: { state: "failed", result: null, issue: { code: "content_policy", message: "TEST FIXTURE: The change was declined.", retryable: false } } });
      return;
    }
    await route.fulfill({ json: await fixtureVariant() });
  });
  await page.goto("/");
  await fillPosterReview(page);
  await page.getByRole("button", { name: "Review poster" }).click();
  await page.getByRole("button", { name: "Test a variant" }).click();
  await expect(page.getByLabel("What should change?")).toBeFocused();
  await page.getByLabel("What should change?").fill("Replace it with a paper cup");
  await page.getByRole("button", { name: "Make variant" }).click();
  await expect(page.locator("#variant-error")).toHaveText("TEST FIXTURE: The change was declined.");
  await page.getByRole("button", { name: "Make variant" }).click();
  await expect(page.getByRole("heading", { name: "Change the hand" })).toBeVisible();
  expect(variantForms[1]).toMatchObject({ context: "TEST-FIXTURE-CONTEXT", regionId: "G1", instruction: "Replace it with a paper cup", publicationDate: "2026-11-04", copy: koreanCopy });
  await expect(page.locator(".lens .pill")).toHaveText("Generated");
  await expect(page.locator(".tag.r")).toContainText("Generated");
  await expect(page.locator(".lens")).toContainText("No hand in the selected area");
  await expect(page.locator(".lens")).toContainText("80% of the selected area, 2% of everything else");
  const slider = page.getByLabel("Comparison position, with the original on the left and the generated variant on the right");
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await expect(slider).toHaveValue("51");
  await page.getByRole("button", { name: "Variant", exact: true }).click();
  await expect(page.getByText("Generated by Muse Image")).toBeVisible();
  await page.getByRole("button", { name: "Show measured changes" }).click();
  await noViolations(page);
  await page.screenshot({ path: testInfo.outputPath("variant-compare.png"), fullPage: true });
  await page.getByRole("button", { name: "Compare findings" }).click();
  await expect(page.getByRole("heading", { name: "Findings in each version" })).toBeFocused();
  await expect(page.locator(".evidence")).toContainText("TEST FIXTURE: The variant is a synthetic image made for this comparison.");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.locator(".lens")).toContainText("Finding 1 of 2");
  await noOverflow(page);
  // The only expected console line is Chrome logging the deliberate 422 refusal above.
  expect(warnings.filter((text) => !text.includes("Download the React DevTools") && !text.includes("status of 422"))).toEqual([]);
});

test("a variant of one of several matches uses the chosen area and warns when another match is gone", async ({ page }) => {
  const response = fixtureResult("2026-11-04", { image: true });
  if (response.state !== "completed") throw new Error("Expected fixture result");
  const second = { left: 240, top: 300, right: 360, bottom: 420 };
  const segmentation = response.result.segmentation;
  segmentation.concepts[0]!.regionIds = ["G1", "G2"];
  segmentation.regions = [{ ...segmentation.regions[0]!, matchesForConcept: 2 }, { ...segmentation.regions[0]!, id: "G2", box: second, matchesForConcept: 2, mask: null }];
  const forms: Array<Record<string, string>> = [];
  await page.route("**/api/review", (route) => route.fulfill({ json: response }));
  await page.route("**/api/variant", async (route) => {
    const request = route.request();
    const form = await new Response(new Uint8Array(request.postDataBuffer()!), { headers: { "content-type": request.headers()["content-type"]! } }).formData();
    forms.push(Object.fromEntries([...form.entries()].filter(([, value]) => typeof value === "string")) as Record<string, string>);
    const variant = await fixtureVariant();
    if (variant.state !== "completed") throw new Error("Expected fixture variant");
    variant.result.target = { regionId: "G2", concept: "hand", box: second };
    variant.result.redetection = { status: "found", regions: [{ box: second, mask: null }], targetStillDetected: true, otherMatches: 1, otherMatchesMissing: 1 };
    await route.fulfill({ json: variant });
  });
  await page.goto("/");
  await fillPosterReview(page);
  await page.getByRole("button", { name: "Review poster" }).click();
  await expect(page.getByRole("button", { name: "hand, area 2 of 2, finding 1" })).toBeVisible();
  await expect(page.locator(".lens")).toContainText("SAM 3.1 outlined 2 areas matching \"hand\"");
  await page.getByRole("button", { name: "Test a variant" }).click();
  await expect(page.getByText("SAM 3.1 outlined 2 areas. Choose one to change.")).toBeVisible();
  await page.getByRole("button", { name: "Area 2", exact: true }).click();
  await expect(page.getByRole("button", { name: "Area 2", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("What should change?").fill("Replace it with a paper cup");
  await page.getByRole("button", { name: "Make variant" }).click();
  await expect(page.locator(".lens")).toContainText("Still finds the hand in the selected area. 0 of 1 other matches still found");
  await expect(page.locator(".lens")).toContainText("Another hand outside the selected area is gone");
  expect(forms[0]).toMatchObject({ regionId: "G2" });
  await noViolations(page);
});

test("a variant flags an original that was assessed differently from its first review", async ({ page }) => {
  await page.route("**/api/review", (route) => route.fulfill({ json: fixtureResult("2026-11-04", { image: true }) }));
  await page.route("**/api/variant", async (route) => route.fulfill({ json: await fixtureVariant({ drift: true }) }));
  await page.goto("/");
  await fillPosterReview(page);
  await page.getByRole("button", { name: "Review poster" }).click();
  await page.getByRole("button", { name: "Test a variant" }).click();
  await page.getByLabel("What should change?").fill("Replace it with a paper cup");
  await page.getByRole("button", { name: "Make variant" }).click();
  const lens = page.locator(".lens");
  await expect(lens).toContainText("First review of the original");
  await expect(lens).toContainText("No supported concern found, 0 findings");
  await expect(lens).toContainText("cannot isolate the edit");
  await expect(lens.locator("p[lang]")).toHaveCount(0);
  await noViolations(page);
});

test("plain text replies from the hosting platform get accurate messages", async ({ page }) => {
  let status = 413;
  await page.route("**/api/review", (route) => route.fulfill({ status, contentType: "text/plain", body: status === 413 ? "Request Entity Too Large\n\nFUNCTION_PAYLOAD_TOO_LARGE" : "An error occurred with your deployment\n\nFUNCTION_INVOCATION_TIMEOUT" }));
  await page.goto("/");
  await fillPosterReview(page);
  await page.getByRole("button", { name: "Review poster" }).click();
  await expect(page.locator("#file-error")).toHaveText("This upload is larger than the hosting platform accepts. Choose a smaller image file and try again.");
  await expect(page.getByText("could not be reached")).toHaveCount(0);
  status = 504;
  await page.getByRole("button", { name: "Review again" }).click();
  await expect(page.getByRole("heading", { name: "Review incomplete" })).toBeVisible();
  await expect(page.getByText("The hosting platform stopped the review before it finished.", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No supported concern found", exact: true })).toHaveCount(0);
});

test("source counts separate passages, pages and documented notes, and copy language is marked per text", async ({ page }) => {
  const response = fixtureResult("2026-11-04");
  if (response.state !== "completed") throw new Error("Expected fixture result");
  const first = response.result.sources[0]!;
  response.result.sources.push({ ...first, id: "S2", blockIndex: 1 });
  response.result.findings[0]!.sourceIds = ["S1", "S2"];
  await page.route("**/api/review", (route) => route.fulfill({ json: response }));
  await page.goto("/");
  await openCopy(page);
  await copyField(page).fill("A quiet camping night with friends");
  await page.getByLabel("Runs on").fill("2026-11-04");
  await page.getByRole("button", { name: "Review copy" }).click();
  await expect(page.getByRole("heading", { name: "Emerging signal", exact: true })).toBeVisible();
  await expect(page.locator(".copy-card p")).not.toHaveAttribute("lang", /.+/);
  await page.getByRole("button", { name: "Scope and all evidence" }).click();
  await expect(page.locator(".evidence .facts")).toContainText("Cited web pages1, 2 passages");
  await expect(page.locator(".evidence")).toContainText("2 cited passages from 1 page on 1 site.");
  // Both passages sit under their one page, which names its host and title once.
  await expect(page.locator(".evidence .src", { hasText: "example.com" })).toHaveCount(1);
  await expect(page.locator(".evidence .src .passages li")).toHaveCount(2);
  await expect(page.locator(".copy-reviewed")).toHaveAttribute("tabindex", "0");
  await noViolations(page);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "New review" }).click();
  await fillCopyReview(page);
  await page.getByRole("button", { name: "Review copy" }).click();
  await expect(page.locator(".copy-card p")).toHaveAttribute("lang", "ko");
});

test("setup leads with the poster and always shows the optional ad copy field", async ({ page }) => {
  await page.route("**/api/review", (route) => route.fulfill({ json: fixtureResult("2026-11-04") }));
  await page.goto("/");
  await expect(page.locator(".copy-add, .copy-field details")).toHaveCount(0);
  await expect(copyField(page)).toBeVisible();
  await expect(page.locator(".copy-field .optional")).toHaveText("Optional");
  await expect(copyField(page)).toHaveAccessibleDescription(/Optional/);
  await expect(page.locator("#copy-count")).toHaveText("0 / 5,000");
  // The poster input comes before the copy field in reading and tab order.
  expect(await page.evaluate(() => Boolean(document.getElementById("poster-file")!.compareDocumentPosition(document.getElementById("copy")!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  await expect(page.getByText("Your poster goes to Meta when you review, with any ad copy you add.").filter({ visible: true })).toHaveCount(1);
  await copyField(page).fill(koreanCopy);
  await expect(page.locator("#copy-count")).toHaveText(`${koreanCopy.length} / 5,000`);
  await page.getByLabel("Runs on").fill("2026-11-04");
  await page.getByRole("button", { name: "Review copy" }).click();
  await expect(page.locator(".copy-card")).toContainText(koreanCopy);
});

test("the ported studio paints its grain and review rim without breaking the content security policy", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (message) => { if (/Content Security Policy|Refused to/i.test(message.text())) violations.push(message.text()); });
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/review", async (route) => { await held; await route.fulfill({ json: fixtureResult("2026-11-04", { image: true }) }); });
  await page.goto("/");
  const grain = await page.evaluate(() => { const style = getComputedStyle(document.body, "::after"); return { image: style.backgroundImage, opacity: style.opacity, z: style.zIndex, position: style.position, isolation: getComputedStyle(document.body).isolation }; });
  expect(grain).toMatchObject({ opacity: "0.05", z: "-1", position: "fixed", isolation: "isolate" });
  expect(grain.image).toContain("feTurbulence");
  await fillPosterReview(page);
  await page.getByRole("button", { name: "Review poster" }).click();
  await expect(page.locator(".scan")).toBeVisible();
  // The rim fades in over 0.6 seconds while the review runs.
  await expect.poll(() => page.locator(".halo").evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
  const rim = await page.locator(".halo").evaluate((element) => ({ animation: getComputedStyle(element).animationName, image: getComputedStyle(element).backgroundImage }));
  expect(rim.animation).toBe("orbit");
  expect(rim.image).toContain("conic-gradient");
  release!();
  await expect(page.getByRole("heading", { name: "Emerging signal", exact: true })).toBeVisible();
  expect(violations).toEqual([]);
});

test("every studio state passes automated checks at 2560, 1920, 1440, 1024, 390 and 320 pixels", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "This test sets each width itself.");
  test.setTimeout(360_000);
  await page.route("**/api/review", (route) => route.fulfill({ json: fixtureResult("2026-11-04", { image: true }) }));
  await page.route("**/api/variant", async (route) => route.fulfill({ json: await fixtureVariant() }));
  for (const [width, height] of [[2560, 1440], [1920, 1080], [1440, 900], [1024, 768], [390, 844], [320, 640]] as const) {
    await page.setViewportSize({ width, height });
    const check = async (state: string) => {
      // Each state is checked once it has settled: entrance and fade animations have ended.
      await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"
        || animation.effect?.getTiming().iterations === Infinity));
      await noOverflow(page);
      await noViolations(page);
      if (width > 900) return;
      // Phone controls keep a 44 pixel target in both directions.
      const small = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("button, a[href], summary, input, textarea, select")]
        .filter((element) => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && !element.closest(".sr-only, .vh")
          && !element.classList.contains("skip-link") && !element.classList.contains("split-range") && (element as HTMLInputElement).type !== "file")
        .map((element) => ({ element, rect: element.getBoundingClientRect() }))
        .filter(({ rect }) => rect.height < 44 || rect.width < 44)
        .map(({ element, rect }) => `${element.tagName.toLowerCase()}.${element.className} ${element.textContent?.trim().slice(0, 30)} ${Math.round(rect.width)}x${Math.round(rect.height)}`));
      expect(small, `${width} ${state}`).toEqual([]);
    };
    await page.goto("/");
    await check("empty");
    await fillPosterReview(page);
    await check("loaded");
    await page.getByRole("button", { name: "Review poster" }).click();
    await expect(page.getByRole("heading", { name: "Emerging signal", exact: true })).toBeVisible();
    await check("result");
    await page.locator(".lens").getByRole("button", { name: "Evidence", exact: true }).click();
    await expect(page.locator("#ev-title")).toBeFocused();
    // The card behind the panel finishes fading before the state is checked.
    await expect.poll(() => page.locator(".right").evaluate((element) => getComputedStyle(element).visibility)).toBe("hidden");
    await check("evidence");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Scope and all evidence" }).click();
    await expect(page.locator("#ev-title")).toBeFocused();
    await expect.poll(() => page.locator(".right").evaluate((element) => getComputedStyle(element).visibility)).toBe("hidden");
    await check("overview");
    await page.keyboard.press("Escape");
    await expect.poll(() => page.locator(".right").evaluate((element) => getComputedStyle(element).visibility)).toBe("visible");
    await page.getByRole("button", { name: "Test a variant" }).click();
    await page.getByLabel("What should change?").fill("Replace it with a paper cup");
    await page.getByRole("button", { name: "Make variant" }).click();
    await expect(page.getByRole("heading", { name: "Change the hand" })).toBeVisible();
    await check("compare");
  }
});

test("long poster file names truncate visibly beside the poster and never reach the top bar", async ({ page }) => {
  await page.route("**/api/review", (route) => route.fulfill({ json: fixtureResult("2026-11-04", { image: true }) }));
  const name = `${"summer-night-camping-campaign-final-approved-version-".repeat(4)}poster.png`;
  await page.goto("/");
  await page.getByLabel("Poster image").setInputFiles({ name, mimeType: "image/png", buffer: await posterBytes() });
  await expect(page.getByAltText(`Poster under review, ${name}`)).toBeVisible();
  const label = page.locator(".frame-tools .file");
  await expect(label).toHaveAttribute("title", name);
  await expect(label).toHaveText(name);
  expect(await label.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await page.getByLabel("Runs on").fill("2026-11-04");
  await page.getByRole("button", { name: "Review poster" }).click();
  await expect(page.getByRole("heading", { name: "Emerging signal", exact: true })).toBeVisible();
  await expect(page.locator(".top")).not.toContainText("summer-night");
  await noOverflow(page);
  await noViolations(page);
});

test("a past planned date runs as a clearly labeled retrospective review", async ({ page }) => {
  await page.route("**/api/review", (route) => route.fulfill({ json: fixtureResult("2021-05-11") }));
  await page.goto("/");
  await openCopy(page);
  await copyField(page).fill(koreanCopy);
  await page.getByLabel("Runs on").fill("2021-05-11");
  await expect(page.locator("#date-note")).toContainText("A past date makes this a retrospective review.");
  await page.getByRole("button", { name: "Review copy" }).click();
  await expect(page.getByRole("heading", { name: "Emerging signal", exact: true })).toBeVisible();
  await expect(page.locator(".when .pill")).toHaveText("Retrospective review");
  await page.getByRole("button", { name: "Scope and all evidence" }).click();
  await expect(page.locator(".evidence .retro-note")).toContainText("Documented cases count only if they were reported before that day.");
  await noViolations(page);
});

test("a future planned date shows no retrospective label", async ({ page }) => {
  await page.route("**/api/review", (route) => route.fulfill({ json: fixtureResult("2099-01-05") }));
  await page.goto("/");
  await fillCopyReview(page);
  await page.getByLabel("Runs on").fill("2099-01-05");
  await page.getByRole("button", { name: "Review copy" }).click();
  await expect(page.getByRole("heading", { name: "Emerging signal", exact: true })).toBeVisible();
  await expect(page.locator(".when .pill")).toHaveCount(0);
});

// A streamed /api/review reply the test feeds line by line. The page's fetch returns a
// ReadableStream, so stage events arrive one at a time, as they do from the route.
async function streamStub(page: Page) {
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    const w = window as unknown as { __push: (line: string) => void; __end: () => void; __cancelled: boolean; __requests: number };
    w.__cancelled = false; w.__requests = 0;
    window.fetch = async (input, init) => {
      if (!String(input instanceof Request ? input.url : input).includes("/api/review")) return original(input, init);
      w.__requests += 1;
      let control: ReadableStreamDefaultController<Uint8Array> | null = null;
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({ start(value) { control = value; }, cancel() { w.__cancelled = true; } });
      w.__push = (line) => { try { control?.enqueue(encoder.encode(`${line}\n`)); } catch { /* closed */ } };
      w.__end = () => { try { control?.close(); } catch { /* closed */ } };
      // An aborted fetch closes the connection and errors its body, as a browser does.
      init?.signal?.addEventListener("abort", () => { w.__cancelled = true; try { control?.error(new DOMException("Aborted", "AbortError")); } catch { /* closed */ } });
      return new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson; charset=utf-8" } });
    };
  });
  const push = (value: unknown) => page.evaluate((line) => (window as unknown as { __push: (line: string) => void }).__push(line), typeof value === "string" ? value : JSON.stringify(value));
  const end = () => page.evaluate(() => (window as unknown as { __end: () => void }).__end());
  const progress = (event: Record<string, unknown>) => push({ type: "progress", event });
  return { push, end, progress, open: () => push(`${JSON.stringify({ type: "open" })}${" ".repeat(1100)}`) };
}

// The step list that a review marks: the left column on wide screens, a disclosure on phones.
async function reviewSteps(page: Page) {
  const narrow = (page.viewportSize()?.width ?? 0) <= 900;
  if (narrow) {
    const disclosure = page.locator(".how-narrow");
    await expect(disclosure).toBeVisible();
    if (!(await disclosure.evaluate((element) => (element as HTMLDetailsElement).open))) await disclosure.locator("summary").click();
    return disclosure.locator(".step");
  }
  await expect(page.locator(".how-wide")).toBeVisible();
  return page.locator(".how-wide .step");
}
const STEP_NAMES = ["Poster and date", "Cited web research", "Documented cases", "Assessment and evidence checks", "Regions", "Optional variant test"];

test("how a review works lists the six steps on setup, as a disclosure below the poster on phones", async ({ page }) => {
  await page.goto("/");
  const narrow = (page.viewportSize()?.width ?? 0) <= 900;
  if (narrow) {
    await expect(page.locator(".how-wide")).toBeHidden();
    await expect(page.locator(".how-narrow")).not.toHaveAttribute("open", /.*/);
    const frame = await page.locator(".frame").boundingBox(), disclosure = await page.locator(".how-narrow").boundingBox();
    expect(disclosure!.y).toBeGreaterThan(frame!.y + frame!.height);
  } else await expect(page.getByRole("heading", { name: "How a review works" })).toBeVisible();
  const steps = await reviewSteps(page);
  await expect(steps.locator("b")).toHaveText(STEP_NAMES);
  await expect(steps.locator("small")).toHaveText(["Your upload", "Muse Spark", "NARAK registry", "Muse Spark and server rules", "SAM 3.1", "Muse Image"]);
  // On setup nothing is marked, and no step claims a result or a rate.
  await expect(steps.filter({ has: page.locator(".note") })).toHaveCount(0);
  await expect(page.locator(".how-wide, .how-narrow").filter({ visible: true })).not.toContainText(/%|accura|guarantee/i);
  await noViolations(page);
});

test("streams real stage events into the steps in order, announces them politely and ends on the result", async ({ page }) => {
  const stream = await streamStub(page);
  await page.goto("/");
  await fillPosterReview(page);
  await page.getByRole("button", { name: "Review poster" }).click();
  await expect(page.getByRole("heading", { name: "Reviewing the poster" })).toBeVisible();
  const steps = await reviewSteps(page);
  const classes = async () => (await steps.evaluateAll((items) => items.map((item) => item.className.replace("step", "").trim())));
  expect(await classes()).toEqual(["active", "idle", "idle", "idle", "idle", "idle"]);
  await stream.open();
  await stream.progress({ stage: "research_started" });
  await expect.poll(classes).toEqual(["done", "active", "idle", "idle", "idle", "idle"]);
  await expect(page.getByRole("status")).toHaveText("Web research started. Muse Spark searches the web and cites the pages it uses.");
  await stream.progress({ stage: "research_retried" });
  await expect(steps.nth(1)).toContainText("Running again after a retry");
  await stream.progress({ stage: "research_accepted", pages: 4 });
  await expect(steps.nth(1)).toContainText("4 pages cited, after one retry");
  await expect.poll(classes).toEqual(["done", "done", "active", "idle", "idle", "idle"]);
  await stream.progress({ stage: "cases_checked", checked: 3, selected: 1 });
  await expect(steps.nth(2)).toContainText("3 checked, 1 selected");
  await stream.progress({ stage: "assessment_started" });
  await expect.poll(classes).toEqual(["done", "done", "done", "active", "idle", "idle"]);
  await stream.progress({ stage: "assessment_checked" });
  await stream.progress({ stage: "regions_started", elements: 2 });
  await expect(steps.nth(4)).toContainText("Locating 2 elements");
  await expect.poll(classes).toEqual(["done", "done", "done", "done", "active", "idle"]);
  await expect(page.getByRole("status")).toHaveText("Locating 2 named elements. SAM 3.1 outlines where each element appears on the poster.");
  // The separate progress list is gone, and nothing estimates progress or time.
  await expect(page.locator(".progress-card")).toHaveCount(0);
  await expect(page.locator(".stage")).not.toContainText(/\d+%|remaining|minutes? left|seconds? left/i);
  await noViolations(page);
  await stream.push({ type: "result", response: fixtureResult("2026-11-04", { image: true }) });
  await stream.end();
  await expect(page.getByRole("heading", { name: "Emerging signal", exact: true })).toBeVisible();
  await expect(page.locator(".how-wide, .how-narrow")).toHaveCount(0);
});

test("an assessment retry is shown beside its step and no later step is marked early", async ({ page }) => {
  const stream = await streamStub(page);
  await page.goto("/");
  await fillCopyReview(page);
  await page.getByRole("button", { name: "Review copy" }).click();
  const steps = await reviewSteps(page);
  await stream.open();
  await stream.progress({ stage: "research_started" });
  await stream.progress({ stage: "research_accepted", pages: 2 });
  await stream.progress({ stage: "cases_unavailable" });
  await expect(steps.nth(2)).toHaveClass(/gap/);
  await expect(steps.nth(2)).toContainText("Could not be read");
  await stream.progress({ stage: "assessment_started" });
  await stream.progress({ stage: "assessment_retried" });
  await expect(steps.nth(3)).toContainText("Running again after a retry");
  await expect(steps.nth(3)).toHaveClass(/active/);
  await expect(steps.nth(4)).toHaveClass(/idle/);
  await expect(steps.nth(5)).toHaveClass(/idle/);
  await stream.push({ type: "result", response: fixtureResult("2026-11-04") });
  await stream.end();
  await expect(page.getByRole("heading", { name: "Emerging signal", exact: true })).toBeVisible();
});

test("a broken stream shows the existing failure state and never a clear result", async ({ page }) => {
  const stream = await streamStub(page);
  await page.goto("/");
  await fillCopyReview(page);
  await page.getByRole("button", { name: "Review copy" }).click();
  await stream.open();
  await stream.progress({ stage: "research_started" });
  await stream.end();
  await expect(page.getByRole("heading", { name: "The review could not finish" })).toBeVisible();
  await expect(page.getByText("The review connection ended before a result arrived.", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No supported concern found", exact: true })).toHaveCount(0);
  // A line that breaks the contract fails the same way.
  await page.getByRole("button", { name: "Review again" }).click();
  await stream.open();
  await stream.push({ type: "progress", event: { stage: "research_accepted", pages: 3, excerpt: "model text" } });
  await expect(page.getByRole("heading", { name: "The review could not finish" })).toBeVisible();
  await noViolations(page);
});

test("cancelling a streamed review stops the stream and ignores anything that arrives later", async ({ page }) => {
  const stream = await streamStub(page);
  await page.goto("/");
  await fillCopyReview(page);
  await page.getByRole("button", { name: "Review copy" }).click();
  await stream.open();
  await stream.progress({ stage: "research_started" });
  await expect(page.getByRole("status")).toContainText("Web research started");
  await page.getByRole("button", { name: "Cancel review" }).click();
  await expect(page.getByText("You stopped this review before it finished.", { exact: false })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __cancelled: boolean }).__cancelled)).toBe(true);
  await stream.push({ type: "result", response: fixtureResult("2026-11-04") });
  await page.waitForTimeout(200);
  await expect(page.getByRole("heading", { name: "Emerging signal", exact: true })).toHaveCount(0);
});

test("the background atmosphere stays continuous for the full page height", async ({ page }) => {
  // A short window makes the result page taller than the screen, as an open disclosure did.
  const width = page.viewportSize()!.width;
  await page.setViewportSize({ width, height: width > 900 ? 560 : 640 });
  await page.route("**/api/review", (route) => route.fulfill({ json: fixtureResult("2026-11-04", { image: true }) }));
  await page.goto("/");
  await fillPosterReview(page);
  await page.getByRole("button", { name: "Review poster" }).click();
  await expect(page.getByRole("heading", { name: "Emerging signal", exact: true })).toBeVisible();
  const layers = await page.evaluate(() => {
    const before = getComputedStyle(document.body, "::before"), after = getComputedStyle(document.body, "::after");
    return { tall: document.documentElement.scrollHeight > innerHeight + 40, before: [before.position, before.top, before.bottom], after: after.position, image: before.backgroundImage };
  });
  expect(layers.tall).toBe(true);
  expect(layers.before).toEqual(["fixed", "0px", "0px"]);
  expect(layers.after).toBe("fixed");
  expect(layers.image).toContain("radial-gradient");
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(300);
  // Down the empty right margin, the ground changes smoothly. The old background ended in a
  // step of about 16 levels of luminance where the body box ended.
  if (width > 900) {
    const shot = await page.screenshot();
    const meta = await sharp(shot).metadata();
    const { data } = await sharp(shot).extract({ left: meta.width! - 20, top: 0, width: 20, height: meta.height! }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const rows = Array.from({ length: meta.height! }, (_, y) => { let sum = 0; for (let x = 0; x < 20; x++) { const i = (y * 20 + x) * 3; sum += 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!; } return sum / 20; });
    const steps = rows.slice(0, -2).map((value, y) => Math.abs(rows[y + 2]! - value));
    expect(Math.max(...steps)).toBeLessThan(6);
  }
});

test("two consecutive reviews: another poster starts a clean setup with nothing stale", async ({ page }) => {
  const forms: Array<{ name: string; date: string }> = [];
  await page.route("**/api/review", async (route) => {
    const request = route.request();
    const form = await new Response(new Uint8Array(request.postDataBuffer()!), { headers: { "content-type": request.headers()["content-type"]! } }).formData();
    forms.push({ name: (form.get("image") as File).name, date: String(form.get("publicationDate")) });
    await route.fulfill({ json: fixtureResult(String(form.get("publicationDate")), { image: true }) });
  });
  await page.route("**/api/variant", async (route) => route.fulfill({ json: await fixtureVariant() }));
  await page.goto("/");
  await fillPosterReview(page);
  await page.getByRole("button", { name: "Review poster" }).click();
  await expect(page.getByRole("heading", { name: "Emerging signal", exact: true })).toBeVisible();
  // Leave a variant comparison open, then start again from the result column.
  await page.getByRole("button", { name: "Test a variant" }).click();
  await page.getByLabel("What should change?").fill("Replace it with a paper cup");
  await page.getByRole("button", { name: "Make variant" }).click();
  await expect(page.getByRole("heading", { name: "Change the hand" })).toBeVisible();
  await page.getByRole("button", { name: "Review another poster" }).click();
  await expect(page.getByRole("heading", { name: "Check a poster before it runs" })).toBeFocused();
  await expect(page.locator(".mk, .reticle, .overlay, .vlayer, .lens, .evidence.open, .when")).toHaveCount(0);
  await expect(page.getByLabel("Runs on")).toHaveValue("");
  await expect(page.locator(".samples")).toBeVisible();
  await page.getByLabel("Poster image").setInputFiles({ name: "second-poster.png", mimeType: "image/png", buffer: await posterBytes() });
  await expect(page.getByAltText("Poster under review, second-poster.png")).toBeVisible();
  await page.getByLabel("Runs on").fill("2026-12-24");
  await page.getByRole("button", { name: "Review poster" }).click();
  await expect(page.getByRole("heading", { name: "Emerging signal", exact: true })).toBeVisible();
  await expect(page.locator(".when")).toHaveText("Runs Thu 24 Dec 2026");
  expect(forms).toEqual([{ name: "test-poster.png", date: "2026-11-04" }, { name: "second-poster.png", date: "2026-12-24" }]);
  // The top bar's New review does the same, by keyboard.
  await page.getByRole("button", { name: "New review" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Check a poster before it runs" })).toBeFocused();
  await expect(page.locator(".mk, .reticle, .lens")).toHaveCount(0);
  await noViolations(page);
});

test("a poster dropped on a result, or chosen with Replace while editing, starts a fresh review", async ({ page }) => {
  let reviews = 0;
  await page.route("**/api/review", async (route) => { reviews += 1; await route.fulfill({ json: fixtureResult("2026-11-04", { image: true }) }); });
  await page.goto("/");
  await fillPosterReview(page);
  await page.getByRole("button", { name: "Review poster" }).click();
  await expect(page.getByRole("heading", { name: "Emerging signal", exact: true })).toBeVisible();
  const bytes = (await posterBytes()).toString("base64");
  const transfer = await page.evaluateHandle((data) => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], "dropped.png", { type: "image/png" }));
    return dt;
  }, bytes);
  // The page claims the drag, so the browser never opens the file in place of NARAK.
  const claimed = await page.evaluate((dt) => { const event = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }); document.querySelector(".frame")!.dispatchEvent(event); return event.defaultPrevented; }, transfer);
  expect(claimed).toBe(true);
  await expect(page.locator(".drop-hint")).toContainText("Drop to start a new review");
  await page.dispatchEvent(".frame", "drop", { dataTransfer: transfer });
  await expect(page.getByAltText("Poster under review, dropped.png")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Check a poster before it runs" })).toBeVisible();
  await expect(page.locator(".mk, .reticle, .lens, .drop-hint")).toHaveCount(0);
  // The planned date is kept, so the new poster can be reviewed straight away.
  await expect(page.getByLabel("Runs on")).toHaveValue("2026-11-04");
  await page.getByRole("button", { name: "Review poster" }).click();
  await expect(page.getByRole("heading", { name: "Emerging signal", exact: true })).toBeVisible();
  await editButton(page).click();
  await expect(page.getByLabel("Runs on")).toBeFocused();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Replace" }).click();
  await (await chooser).setFiles({ name: "replaced.png", mimeType: "image/png", buffer: await posterBytes() });
  await expect(page.getByAltText("Poster under review, replaced.png")).toBeVisible();
  await expect(page.getByRole("button", { name: "Review poster" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Back to the result" })).toHaveCount(0);
  expect(reviews).toBe(2);
});

test("the NARAK wordmark reloads the home page and stops an active review", async ({ page }) => {
  const failed: string[] = [];
  page.on("requestfailed", (request) => { if (request.url().includes("/api/review")) failed.push(request.failure()?.errorText ?? "failed"); });
  await page.route("**/api/review", async () => { /* Never answers, like a long review. */ });
  await page.goto("/");
  await fillCopyReview(page);
  await page.getByRole("button", { name: "Review copy" }).click();
  await expect(page.getByRole("heading", { name: "Reviewing the copy" })).toBeVisible();
  const mark = page.getByRole("link", { name: "NARAK" });
  await expect(mark).toHaveAttribute("href", "/");
  const navigation = page.waitForEvent("framenavigated");
  await mark.click();
  await navigation;
  await expect(page.getByRole("heading", { name: "Check a poster before it runs" })).toBeVisible();
  await expect(page.getByLabel("Runs on")).toHaveValue("");
  await expect.poll(() => failed.length).toBeGreaterThan(0);
});

test("sample posters fill the form, wait for Review poster and are hidden once a poster is loaded", async ({ page }) => {
  let reviews = 0;
  let sent: { name: string; date: string; type: string } | null = null;
  await page.route("**/api/review", async (route) => {
    reviews += 1;
    const request = route.request();
    const form = await new Response(new Uint8Array(request.postDataBuffer()!), { headers: { "content-type": request.headers()["content-type"]! } }).formData();
    const file = form.get("image") as File;
    sent = { name: file.name, date: String(form.get("publicationDate")), type: file.type };
    await route.fulfill({ json: fixtureResult("2026-12-08", { image: true }) });
  });
  await page.goto("/");
  const samples = page.locator(".samples");
  await expect(samples.getByRole("heading", { name: "Try a sample" })).toBeVisible();
  await expect(samples.getByRole("button")).toHaveCount(4);
  await expect(samples.locator(".label b")).toHaveText(["Dalbit Mart", "Lumen Quest", "Bori Bakery", "Northline"]);
  await expect(samples.locator(".label small")).toHaveText(["1 Dec 2026", "1 Dec 2026", "8 Dec 2026", "8 Dec 2026"]);
  // The grid sits below the copy field, and on phones below the upload area too.
  const copy = await page.locator(".copy-field").boundingBox(), grid = await samples.boundingBox();
  expect(grid!.y).toBeGreaterThan(copy!.y + copy!.height - 1);
  if ((page.viewportSize()?.width ?? 0) <= 900) {
    const drop = await page.locator(".frame").boundingBox();
    expect(grid!.y).toBeGreaterThan(drop!.y + drop!.height);
  }
  await noViolations(page);
  await samples.getByRole("button", { name: /Bori Bakery sample/ }).click();
  await expect(page.getByAltText("Poster under review, bori-bakery.jpg")).toBeVisible();
  await expect(page.getByLabel("Runs on")).toHaveValue("2026-12-08");
  // A sample without its own copy leaves the copy field empty.
  await expect(copyField(page)).toHaveValue("");
  await expect(page.getByRole("button", { name: "Review poster" })).toBeFocused();
  await expect(samples).toHaveCount(0);
  expect(reviews).toBe(0);
  await page.getByRole("button", { name: "Review poster" }).click();
  await expect(page.getByRole("heading", { name: "Emerging signal", exact: true })).toBeVisible();
  expect(sent).toEqual({ name: "bori-bakery.jpg", date: "2026-12-08", type: "image/jpeg" });
});

test("the Dalbit Mart sample fills its ad copy, which stays editable and goes with the review", async ({ page }) => {
  let sent: { name: string; date: string; copy: string } | null = null;
  await page.route("**/api/review", async (route) => {
    const request = route.request();
    const form = await new Response(new Uint8Array(request.postDataBuffer()!), { headers: { "content-type": request.headers()["content-type"]! } }).formData();
    sent = { name: (form.get("image") as File).name, date: String(form.get("publicationDate")), copy: String(form.get("copy")) };
    await route.fulfill({ json: fixtureResult("2026-12-01", { image: true }) });
  });
  await page.goto("/");
  await page.locator(".samples").getByRole("button", { name: /Dalbit Mart sample/ }).click();
  await expect(page.getByAltText("Poster under review, dalbit-camping.jpg")).toBeVisible();
  await expect(page.getByLabel("Runs on")).toHaveValue("2026-12-01");
  await expect(copyField(page)).toHaveValue("Emotional Camping Must-have Item");
  await expect(page.locator("#copy-count")).toHaveText("32 / 5,000");
  await copyField(page).fill("Emotional Camping Must-have Item, this weekend");
  await expect(copyField(page)).toHaveValue("Emotional Camping Must-have Item, this weekend");
  await page.getByRole("button", { name: "Review poster" }).click();
  await expect(page.getByRole("heading", { name: "Emerging signal", exact: true })).toBeVisible();
  expect(sent).toEqual({ name: "dalbit-camping.jpg", date: "2026-12-01", copy: "Emotional Camping Must-have Item, this weekend" });
});

test("only the four supplied samples are served, and the excluded poster is not", async ({ request }) => {
  for (const id of ["dalbit-camping", "lumen-quest", "bori-bakery", "northline-shoe"]) {
    for (const [path, type] of [[`/samples/${id}.jpg`, "image/jpeg"], [`/samples/${id}-thumb.webp`, "image/webp"]] as const) {
      const reply = await request.get(path);
      expect(reply.status(), path).toBe(200);
      expect(reply.headers()["content-type"], path).toContain(type);
    }
  }
  for (const path of ["/samples/moru-coffee.png", "/samples/moru-coffee.jpg"]) expect((await request.get(path)).status(), path).toBe(404);
});

test("the evidence panel groups passages by page, shows the outcome once and hides the card behind it", async ({ page }) => {
  const response = fixtureResult("2026-11-04", { image: true });
  if (response.state !== "completed") throw new Error("Expected fixture result");
  const first = response.result.sources[0]!;
  const passage = ", and then the poster was withdrawn after complaints";
  response.result.sources.push({ ...first, id: "S2", blockIndex: 1, citedPassage: passage, annotation: { ...first.annotation, start_index: 0, end_index: passage.length } });
  response.result.findings[0]!.sourceIds = ["S1", "S2"];
  await page.route("**/api/review", (route) => route.fulfill({ json: response }));
  await page.goto("/");
  await fillPosterReview(page);
  await page.getByRole("button", { name: "Review poster" }).click();
  await expect(page.getByRole("heading", { name: "Emerging signal", exact: true })).toBeVisible();
  // The outcome is stated once, in the heading.
  await expect(page.getByText("Emerging signal", { exact: true }).filter({ visible: true })).toHaveCount(1);
  await page.locator(".lens").getByRole("button", { name: "Evidence", exact: true }).click();
  await expect(page.locator("#ev-title")).toBeFocused();
  const panel = page.locator(".evidence");
  await expect(panel.locator(".src")).toHaveCount(1);
  await expect(panel.locator(".src .src-top b")).toHaveText("example.com");
  await expect(panel.locator(".src .passages li")).toHaveCount(2);
  // A passage that starts mid sentence reads cleanly, with no word added.
  await expect(panel.locator(".src .passages li").nth(1)).toHaveText("\u2026and then the poster was withdrawn after complaints");
  await expect(panel.locator(".group-label")).toHaveCount(1);
  const text = await panel.innerText();
  expect(text).not.toMatch(/\b[SR]\d+\b/);
  expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
  expect(text).not.toMatch(/cited research summar/i);
  // The exact provider text stays one step away, apart from the model's own inference.
  await panel.getByText("Original text and citation trace").click();
  await expect(panel.locator(".trace .raw").nth(1)).toHaveText(passage);
  await expect(panel.locator(".voice", { hasText: "Inference" })).toContainText("It is not a source.");
  // The card beside the poster is hidden while the panel is open, so nothing shows clipped.
  await expect.poll(() => page.locator(".right").evaluate((element) => getComputedStyle(element).visibility)).toBe("hidden");
  await noViolations(page);
  await page.keyboard.press("Escape");
  await expect.poll(() => page.locator(".right").evaluate((element) => getComputedStyle(element).visibility)).toBe("visible");
});

test("the planned date shows under the heading and the top bar names no file", async ({ page }) => {
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/review", async (route) => { await held; await route.fulfill({ json: fixtureResult("2026-11-04", { image: true }) }); });
  await page.goto("/");
  await expect(page.locator(".when")).toHaveCount(0);
  await fillPosterReview(page);
  await expect(page.locator(".left .when")).toHaveText("Runs Wed 4 Nov 2026");
  await page.getByRole("button", { name: "Review poster" }).click();
  await expect(page.locator(".left .when")).toHaveText("Runs Wed 4 Nov 2026");
  release!();
  await expect(page.getByRole("heading", { name: "Emerging signal", exact: true })).toBeVisible();
  await expect(page.locator(".left .when")).toHaveText("Runs Wed 4 Nov 2026");
  await expect(page.locator(".top")).not.toContainText("test-poster.png");
  await expect(page.locator(".top")).not.toContainText("2026");
});

test("the favicon set is served in the formats Next.js links", async ({ page, request }) => {
  await page.goto("/");
  const links = await page.evaluate(() => [...document.querySelectorAll<HTMLLinkElement>('link[rel="icon"], link[rel="apple-touch-icon"]')].map((link) => ({ rel: link.rel, href: new URL(link.href).pathname, type: link.type })));
  expect(links.map((link) => link.href).sort()).toEqual(["/apple-icon.png", "/favicon.ico", "/icon.svg"]);
  for (const [path, type] of [["/icon.svg", "image/svg+xml"], ["/favicon.ico", "image/x-icon"], ["/apple-icon.png", "image/png"]] as const) {
    const reply = await request.get(path);
    expect(reply.status(), path).toBe(200);
    expect(reply.headers()["content-type"], path).toContain(type);
  }
});
