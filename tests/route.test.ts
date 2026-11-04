import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST, maxDuration } from "@/app/api/review/route";
import { REVIEW_TIMEOUT_MS } from "@/lib/review-contract";

beforeEach(() => vi.spyOn(console, "info").mockImplementation(() => undefined));
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function request(origin?: string, copy = "An ordinary cup of tea.") {
  const form = new FormData();
  form.set("copy", copy);
  form.set("publicationDate", "2026-11-04");
  return new Request("http://localhost/api/review", { method: "POST", body: form, headers: origin ? { origin } : undefined });
}

describe("review route", () => {
  it("leaves route headroom around upload, review and client deadlines within Fluid Compute Hobby limits", () => {
    expect(REVIEW_TIMEOUT_MS).toBe(180_000);
    expect(REVIEW_TIMEOUT_MS + 15_000).toBeLessThan(maxDuration * 1000);
    expect(maxDuration).toBeLessThanOrEqual(300);
  });
  it("returns explicit unavailable status when credentials are absent", async () => {
    vi.stubEnv("MODEL_API_KEY", "");
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({ state: "unavailable", result: null, issue: { code: "missing_credentials" } });
  });

  it("validates input before checking provider availability", async () => {
    vi.stubEnv("MODEL_API_KEY", "");
    const response = await POST(request(undefined, ""));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ state: "failed", issue: { code: "invalid_input" } });
  });

  it("rejects cross-origin requests", async () => {
    const response = await POST(request("https://example.com"));
    expect(response.status).toBe(403);
  });

  it("rejects cross-site submissions even without an Origin header", async () => {
    const value = request(); value.headers.set("sec-fetch-site", "cross-site");
    expect((await POST(value)).status).toBe(403);
  });

  it("accepts the browser Host when Next.js uses an internal request hostname", async () => {
    vi.stubEnv("MODEL_API_KEY", "");
    const value = request("http://127.0.0.1:3100");
    value.headers.set("host", "127.0.0.1:3100");
    expect((await POST(value)).status).toBe(503);
  });

  it("rejects JSON and malformed multipart input", async () => {
    for (const contentType of ["application/json", "multipart/form-data; boundary=broken"]) {
      const response = await POST(new Request("http://localhost/api/review", { method: "POST", body: "{}", headers: { "content-type": contentType } }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ result: null, issue: { code: "invalid_input" } });
    }
  });
});
