import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import sharp from "sharp";
import type { ReviewResponse } from "../../src/lib/review-contract";
import { MAX_IMAGE_BYTES } from "../../src/lib/review-contract";
import { assessment, koreanCopy, researchText } from "../fixtures";

function fixtureResult(publicationDate: string): ReviewResponse {
  const data = assessment();
  return { state: "completed", result: {
    outcome: "emerging_signal", summary: "TEST FIXTURE: An unverified signal for browser validation only.",
    observations: data.observations, findings: data.findings, verifiedCaseIds: [],
    limitations: ["TEST FIXTURE: No live research was performed."],
    searchCalls: [{ id: "search_fixture", status: "completed" }],
    sources: [{
      id: "S1", evidenceState: "unverified", responseId: "response_fixture", messageId: "message_fixture", blockIndex: 0,
      citedPassage: researchText,
      annotation: { type: "url_citation", url: "https://example.com/cited-fixture", title: "Synthetic source fixture", start_index: 0, end_index: researchText.length },
    }],
    registry: { state: "available", checkedCases: 0, matchedCaseIds: [], evidence: [] },
    scope: { market: "KR", publicationDate, checkedAt: "2026-11-03T12:00:00Z", hasImage: false, hasCopy: true, completedSearches: 1, citedSources: 1, description: "Synthetic browser fixture only." },
  } };
}

async function fillReview(page: Page) {
  await page.getByLabel("Advertisement copy", { exact: true }).fill(koreanCopy);
  await page.getByLabel("Proposed publication").fill("2026-11-04");
}

test("empty workspace is responsive, keyboard accessible, and has no automated accessibility violations", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page).toHaveTitle("NARAK | Creative context review");
  await expect(page.getByRole("heading", { name: "Before it goes public." })).toBeVisible();
  await expect(page.getByText("No review has been run for these inputs.")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to creative review" })).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Advertisement image", { exact: true })).toBeFocused();
  const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth }));
  expect(size.scroll).toBeLessThanOrEqual(size.viewport);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByLabel("Advertisement copy", { exact: true }).focus();
  await page.screenshot({ path: testInfo.outputPath("workspace.png"), fullPage: true });
});

test("validates missing inputs and preserves Korean copy through a real unavailable response", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Review creative" }).click();
  await expect(page.locator("#review-form").getByRole("alert")).toHaveText("Add advertisement copy or an image to begin.");
  await page.getByLabel("Advertisement copy", { exact: true }).fill(koreanCopy);
  await page.getByRole("button", { name: "Review creative" }).click();
  await expect(page.locator("#review-form").getByRole("alert")).toHaveText("Choose a valid publication date.");
  await page.getByLabel("Proposed publication").fill("2026-11-04");
  const response = page.waitForResponse("**/api/review");
  await page.getByRole("button", { name: "Review creative" }).click();
  expect((await response).status()).toBe(503);
  await expect(page.getByRole("heading", { name: "Live review is unavailable." })).toBeVisible();
  await expect(page.getByLabel("Advertisement copy", { exact: true })).toHaveValue(koreanCopy);
  await expect(page.getByRole("heading", { name: "No supported concern found", exact: true })).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("unavailable.png"), fullPage: true });
});

test("previews a valid image and rejects unsupported, large, and corrupt files", async ({ page }) => {
  await page.goto("/");
  const fileInput = page.getByLabel("Advertisement image", { exact: true });
  await fileInput.setInputFiles({ name: "unsupported.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg/>") });
  await expect(page.locator("#review-form").getByRole("alert")).toContainText("JPEG, PNG, or WebP");
  await fileInput.setInputFiles({ name: "large.png", mimeType: "image/png", buffer: Buffer.alloc(MAX_IMAGE_BYTES + 1) });
  await expect(page.locator("#review-form").getByRole("alert")).toContainText("up to 4 MB");
  await fileInput.setInputFiles({ name: "corrupt.png", mimeType: "image/png", buffer: Buffer.from("not an image") });
  await expect(page.locator("#review-form").getByRole("alert")).toContainText("could not be previewed");
  const buffer = await sharp({ create: { width: 900, height: 500, channels: 3, background: "#cfd8ba" } }).png().toBuffer();
  await fileInput.setInputFiles({ name: "original-test-creative.png", mimeType: "image/png", buffer });
  const preview = page.getByAltText("Preview of your advertisement");
  await expect(preview).toBeVisible();
  expect(await preview.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(900);
  await page.getByRole("button", { name: "Remove image" }).click();
  await expect(preview).toHaveCount(0);
  await expect(page.getByText("Place your creative here")).toBeVisible();
});

test("loading disables edits, shows cited results, and re-analysis uses the latest copy and date", async ({ page }) => {
  const submissions: Array<{ copy: string; date: string }> = [];
  let release: (() => void) | undefined;
  const waitForRelease = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/review", async (route) => {
    const request = route.request();
    const form = await new Response(new Uint8Array(request.postDataBuffer()!), { headers: { "content-type": request.headers()["content-type"]! } }).formData();
    const date = String(form.get("publicationDate"));
    submissions.push({ copy: String(form.get("copy")), date });
    if (submissions.length === 1) await waitForRelease;
    await route.fulfill({ json: fixtureResult(date) });
  });
  await page.goto("/");
  await fillReview(page);
  await page.getByRole("button", { name: "Review creative" }).click();
  await expect(page.getByRole("button", { name: "Reviewing creative..." })).toBeDisabled();
  await expect(page.getByLabel("Advertisement copy", { exact: true })).toBeDisabled();
  await expect(page.getByText("Looking beyond the creative.")).toBeVisible();
  release!();
  await expect(page.getByRole("heading", { name: "Emerging signal", exact: true })).toBeVisible();
  await expect(page.getByText("TEST FIXTURE: An unverified signal for browser validation only.")).toBeVisible();
  await expect(page.getByRole("link", { name: /Synthetic source fixture/ })).toHaveAttribute("href", "https://example.com/cited-fixture");
  await page.getByText("Citation trace", { exact: true }).click();
  await expect(page.getByText("response_fixture", { exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByLabel("Advertisement copy", { exact: true }).fill(`${koreanCopy} revised`);
  await expect(page.getByRole("heading", { name: "Your creative has changed." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Emerging signal", exact: true })).toHaveCount(0);
  await page.getByLabel("Proposed publication").fill("2026-12-12");
  await page.getByRole("button", { name: "Review again" }).click();
  await expect(page.getByRole("heading", { name: "Emerging signal", exact: true })).toBeVisible();
  expect(submissions).toEqual([{ copy: koreanCopy, date: "2026-11-04" }, { copy: `${koreanCopy} revised`, date: "2026-12-12" }]);
  await expect(page.getByText("2026-12-12", { exact: true })).toBeVisible();
});

test("incomplete retrieval cannot appear as a successful negative review", async ({ page }) => {
  await page.route("**/api/review", (route) => route.fulfill({ json: {
    state: "incomplete", result: null, issue: { code: "insufficient_sources", message: "TEST FIXTURE: No usable source annotations were returned.", retryable: true },
  } }));
  await page.goto("/");
  await fillReview(page);
  await page.getByRole("button", { name: "Review creative" }).click();
  await expect(page.getByRole("heading", { name: "There is not enough to conclude." })).toBeVisible();
  await expect(page.getByText("No assessment was issued. An incomplete review does not mean no concern was found.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "No supported concern found", exact: true })).toHaveCount(0);
});

test("registry references remain distinct from provider citations and link to their trace", async ({ page }, testInfo) => {
  const response = fixtureResult("2026-11-04");
  if (response.state !== "completed") throw new Error("Expected fixture result");
  response.result.findings[0]!.sourceIds = ["S1", "R1"];
  response.result.registry = {
    state: "available", checkedCases: 1, matchedCaseIds: ["00000000-0000-4000-8000-000000000001"],
    evidence: [{
      id: "R1", caseId: "00000000-0000-4000-8000-000000000001", evidenceId: "00000000-0000-4000-8000-000000000002",
      sourceId: "00000000-0000-4000-8000-000000000003", caseStatus: "emerging", canonicalUrl: "https://example.com/registry-fixture",
      title: "Synthetic registry fixture", publisher: "Synthetic publisher", publishedOn: "2023-11-30", availableAt: "2023-11-30T10:37:49Z",
      assertionKind: "correction", assertionText: "TEST FIXTURE: Original attributed correction note.", attribution: "Synthetic reporting only",
      provenance: "TEST FIXTURE: Secondary reporting, not independent verification.", relatedEvidenceId: "00000000-0000-4000-8000-000000000004",
    }],
  };
  await page.route("**/api/review", (route) => route.fulfill({ json: response }));
  await page.goto("/"); await fillReview(page); await page.getByRole("button", { name: "Review creative" }).click();
  await expect(page.getByRole("heading", { name: "Emerging signal", exact: true })).toBeVisible();
  await page.getByRole("link", { name: /Source R1/ }).click();
  await expect(page.locator("#source-R1")).toBeFocused();
  await expect(page.getByRole("link", { name: /Synthetic registry fixture/ })).toHaveAttribute("href", "https://example.com/registry-fixture");
  await expect(page.locator("#source-R1")).not.toContainText("Character span");
  await page.getByText("Registry trace", { exact: true }).click();
  await expect(page.getByText("TEST FIXTURE: Secondary reporting, not independent verification.")).toBeVisible();
  const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth }));
  expect(size.scroll).toBeLessThanOrEqual(size.viewport);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("registry-result.png"), fullPage: true });
});

test("cancellation restores editing and ignores a late response", async ({ page }) => {
  let release: (() => void) | undefined;
  const waitForRelease = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/review", async (route) => { await waitForRelease; await route.fulfill({ json: fixtureResult("2026-11-04") }); });
  await page.goto("/");
  await fillReview(page);
  await page.getByRole("button", { name: "Review creative" }).click();
  await expect(page.getByRole("button", { name: "Stop this review" })).toBeVisible();
  await page.getByRole("button", { name: "Stop this review" }).click();
  release!();
  await expect(page.getByLabel("Advertisement copy", { exact: true })).toBeEnabled();
  await expect(page.getByText("You stopped this review before it finished.", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Emerging signal", exact: true })).toHaveCount(0);
});

test("network errors and reduced motion are handled", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/review", (route) => route.abort());
  await page.goto("/");
  await fillReview(page);
  await page.getByRole("button", { name: "Review creative" }).click();
  await expect(page.getByRole("heading", { name: "Live review is unavailable." })).toBeVisible();
  await expect(page.getByText("The review could not be reached.", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
});
