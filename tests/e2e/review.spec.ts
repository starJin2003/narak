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
// Setup leads with the poster, so the optional copy field waits behind a closed disclosure.
async function openCopy(page: Page) {
  if (!(await page.getByLabel("Ad copy, optional").isVisible())) await page.locator(".copy-add summary").click();
  await expect(page.getByLabel("Ad copy, optional")).toBeVisible();
}
async function fillCopyReview(page: Page) {
  await openCopy(page);
  await page.getByLabel("Ad copy, optional").fill(koreanCopy);
  await page.getByLabel("Runs on").fill("2026-11-04");
}
async function fillPosterReview(page: Page) {
  await page.getByLabel("Poster image").setInputFiles({ name: "test-poster.png", mimeType: "image/png", buffer: await posterBytes() });
  await expect(page.getByAltText("Poster under review, test-poster.png")).toBeVisible();
  await openCopy(page);
  await page.getByLabel("Ad copy, optional").fill(koreanCopy);
  await page.getByLabel("Runs on").fill("2026-11-04");
}
// The edit control is the date chip in the top bar, or beside the heading on a phone.
const editButton = (page: Page) => page.getByRole("button", { name: /Edit the creative or date/ }).filter({ visible: true }).first();

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
  await page.getByLabel("Ad copy, optional").fill(koreanCopy);
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
  await expect(page.getByLabel("Ad copy, optional")).toHaveValue(koreanCopy);
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
  await expect(page.locator("#source-S1")).toContainText("Synthetic source fixture");
  await expect(page.locator(".evidence figcaption")).toHaveText("Outline by SAM 3.1");
  await page.locator(".evidence").getByText("Citation trace", { exact: true }).click();
  await expect(page.getByText("response_fixture", { exact: true })).toBeVisible();
  await noViolations(page);
  await page.keyboard.press("Escape");
  await expect(page.locator(".evidence")).not.toHaveClass(/open/);
  await editButton(page).click();
  // Editing moves focus to the date field on the next tick. Waiting for it keeps the fill below
  // from racing that focus change, and checks the focus handoff itself.
  await expect(page.getByLabel("Runs on")).toBeFocused();
  await page.getByLabel("Ad copy, optional").fill(`${koreanCopy} revised`);
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
  // The finding's label follows the server rule: an emerging case backs an emerging signal.
  await expect(page.locator(".lens .pill")).toHaveText("Emerging signal");
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
  await expect(page.locator("#source-S1")).toContainText("Unverified web citation");
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
  await expect(page.getByLabel("Ad copy, optional")).toBeEnabled();
  await expect(page.getByLabel("Ad copy, optional")).toHaveValue(koreanCopy);
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
  await page.getByLabel("Ad copy, optional").fill("A quiet camping night with friends");
  await page.getByLabel("Runs on").fill("2026-11-04");
  await page.getByRole("button", { name: "Review copy" }).click();
  await expect(page.getByRole("heading", { name: "Emerging signal", exact: true })).toBeVisible();
  await expect(page.locator(".copy-card p")).not.toHaveAttribute("lang", /.+/);
  await page.getByText("About this outcome").click();
  await expect(page.locator(".about")).toContainText("Cited web pages1 from 2 cited passages");
  await page.getByRole("button", { name: "All evidence" }).click();
  await expect(page.locator(".evidence")).toContainText("2 cited passages from 1 page on 1 site.");
  await expect(page.locator(".copy-reviewed")).toHaveAttribute("tabindex", "0");
  await noViolations(page);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "New review" }).click();
  await fillCopyReview(page);
  await page.getByRole("button", { name: "Review copy" }).click();
  await expect(page.locator(".copy-card p")).toHaveAttribute("lang", "ko");
});

test("setup leads with the poster and keeps optional ad copy behind a closed disclosure", async ({ page }) => {
  await page.route("**/api/review", (route) => route.fulfill({ json: fixtureResult("2026-11-04") }));
  await page.goto("/");
  const summary = page.locator(".copy-add summary");
  await expect(summary).toHaveText("Add ad copy");
  await expect(page.getByLabel("Ad copy, optional")).toBeHidden();
  // The poster input comes before the copy disclosure in reading and tab order.
  expect(await page.evaluate(() => Boolean(document.getElementById("poster-file")!.compareDocumentPosition(document.querySelector(".copy-add")!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  await expect(page.getByText("Your poster goes to Meta when you review, with any ad copy you add.").filter({ visible: true })).toHaveCount(1);
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Ad copy, optional")).toBeVisible();
  await page.getByLabel("Ad copy, optional").fill(koreanCopy);
  await expect(summary).toHaveText("Ad copy added");
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
  const grain = await page.evaluate(() => { const style = getComputedStyle(document.body, "::before"); return { image: style.backgroundImage, opacity: style.opacity, z: style.zIndex, isolation: getComputedStyle(document.body).isolation }; });
  expect(grain).toMatchObject({ opacity: "0.05", z: "-1", isolation: "isolate" });
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

test("every studio state passes automated checks at 1440, 1024, 390 and 320 pixels", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "This test sets each width itself.");
  test.setTimeout(240_000);
  await page.route("**/api/review", (route) => route.fulfill({ json: fixtureResult("2026-11-04", { image: true }) }));
  await page.route("**/api/variant", async (route) => route.fulfill({ json: await fixtureVariant() }));
  for (const [width, height] of [[1440, 900], [1024, 768], [390, 844], [320, 640]] as const) {
    await page.setViewportSize({ width, height });
    const check = async (state: string) => {
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
    await check("evidence");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Test a variant" }).click();
    await page.getByLabel("What should change?").fill("Replace it with a paper cup");
    await page.getByRole("button", { name: "Make variant" }).click();
    await expect(page.getByRole("heading", { name: "Change the hand" })).toBeVisible();
    await check("compare");
  }
});

test("long poster file names truncate visibly and stay available in full", async ({ page }) => {
  await page.route("**/api/review", (route) => route.fulfill({ json: fixtureResult("2026-11-04", { image: true }) }));
  const name = `${"summer-night-camping-campaign-final-approved-version-".repeat(4)}poster.png`;
  await page.goto("/");
  await page.getByLabel("Poster image").setInputFiles({ name, mimeType: "image/png", buffer: await posterBytes() });
  await expect(page.getByAltText(`Poster under review, ${name}`)).toBeVisible();
  await page.getByLabel("Runs on").fill("2026-11-04");
  await page.getByRole("button", { name: "Review poster" }).click();
  await expect(page.getByRole("heading", { name: "Emerging signal", exact: true })).toBeVisible();
  const label = page.locator(".obj .name");
  if (await label.isVisible()) {
    await expect(label).toHaveAttribute("title", name);
    await expect(label).toHaveText(name);
    expect(await label.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  }
  await noOverflow(page);
  await noViolations(page);
});

test("a past planned date runs as a clearly labeled retrospective review", async ({ page }) => {
  await page.route("**/api/review", (route) => route.fulfill({ json: fixtureResult("2021-05-11") }));
  await page.goto("/");
  await openCopy(page);
  await page.getByLabel("Ad copy, optional").fill(koreanCopy);
  await page.getByLabel("Runs on").fill("2021-05-11");
  await expect(page.locator("#date-note")).toContainText("A past date makes this a retrospective review.");
  await page.getByRole("button", { name: "Review copy" }).click();
  await expect(page.getByRole("heading", { name: "Emerging signal", exact: true })).toBeVisible();
  await expect(page.locator(".retro .pill")).toHaveText("Retrospective review");
  await expect(page.locator(".retro")).toContainText("Documented cases count only if they were reported before that day.");
  await noViolations(page);
});

test("a future planned date shows no retrospective label", async ({ page }) => {
  await page.route("**/api/review", (route) => route.fulfill({ json: fixtureResult("2099-01-05") }));
  await page.goto("/");
  await fillCopyReview(page);
  await page.getByLabel("Runs on").fill("2099-01-05");
  await page.getByRole("button", { name: "Review copy" }).click();
  await expect(page.getByRole("heading", { name: "Emerging signal", exact: true })).toBeVisible();
  await expect(page.locator(".retro")).toHaveCount(0);
});
