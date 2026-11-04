import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { MAX_IMAGE_BYTES, isCalendarDate } from "@/lib/review-contract";
import { MAX_REQUEST_BYTES, parseReviewInput, readLimitedBody } from "@/server/input";
import { koreanCopy } from "./fixtures";

function request(values: { copy?: string; date?: string; image?: File; market?: string } = {}) {
  const form = new FormData();
  form.set("copy", values.copy ?? "An ordinary cup of tea.");
  form.set("publicationDate", values.date ?? "2026-11-04");
  form.set("market", values.market ?? "KR");
  if (values.image) form.set("image", values.image);
  return new Request("http://localhost/api/review", { method: "POST", body: form });
}

describe("server input validation", () => {
  it("accepts and preserves Korean copy exactly", async () => {
    const copy = `  ${koreanCopy}\n${koreanCopy}  `;
    expect(await parseReviewInput(request({ copy }), new AbortController().signal)).toMatchObject({ copy, market: "KR" });
  });

  it.each(["", "2026-02-30", "2026-13-01", "11/04/2026", "tomorrow"])("rejects invalid publication date %s", async (date) => {
    await expect(parseReviewInput(request({ date }), new AbortController().signal)).rejects.toMatchObject({ issue: { code: "invalid_input", field: "publicationDate" } });
  });

  it("handles leap dates", () => {
    expect(isCalendarDate("2024-02-29")).toBe(true);
    expect(isCalendarDate("2025-02-29")).toBe(false);
  });

  it("requires copy or an image", async () => {
    await expect(parseReviewInput(request({ copy: "  " }), new AbortController().signal)).rejects.toMatchObject({ issue: { field: "copy" } });
  });

  it("rejects excessive copy and unsupported markets", async () => {
    await expect(parseReviewInput(request({ copy: "x".repeat(5001) }), new AbortController().signal)).rejects.toMatchObject({ issue: { field: "copy" } });
    await expect(parseReviewInput(request({ market: "US" }), new AbortController().signal)).rejects.toMatchObject({ issue: { code: "invalid_input" } });
  });

  it.each(["png", "jpeg", "webp"] as const)("accepts a decoded %s image without copy", async (format) => {
    const bytes = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#dfe4d5" } }).toFormat(format).toBuffer();
    const image = new File([new Uint8Array(bytes)], `creative.${format}`, { type: `image/${format}` });
    const result = await parseReviewInput(request({ copy: "", image }), new AbortController().signal);
    expect(result.image?.dataUrl).toBe(`data:image/${format};base64,${bytes.toString("base64")}`);
    expect(result.copy).toBe("");
  });

  it("rejects empty, unsupported, corrupted, and oversized images", async () => {
    const images = [
      new File([], "empty.png", { type: "image/png" }),
      new File(["<svg/>"], "vector.svg", { type: "image/svg+xml" }),
      new File(["not an image"], "fake.png", { type: "image/png" }),
      new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], "large.png", { type: "image/png" }),
    ];
    for (const image of images) {
      await expect(parseReviewInput(request({ image }), new AbortController().signal)).rejects.toMatchObject({ issue: { code: "invalid_input", field: "image" } });
    }
  });

  it("rejects forged image MIME types and excessive pixel counts", async () => {
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: "white" } }).png().toBuffer();
    await expect(parseReviewInput(request({ image: new File([new Uint8Array(png)], "fake.jpg", { type: "image/jpeg" }) }), new AbortController().signal)).rejects.toMatchObject({ issue: { field: "image" } });
    const huge = await sharp({ create: { width: 5000, height: 5000, channels: 3, background: "white" } }).png().toBuffer();
    await expect(parseReviewInput(request({ image: new File([new Uint8Array(huge)], "huge.png", { type: "image/png" }) }), new AbortController().signal)).rejects.toMatchObject({ issue: { field: "image" } });
  });

  it("bounds bodies with and without Content-Length", async () => {
    const declared = new Request("http://localhost", { method: "POST", body: "x", headers: { "content-length": String(MAX_REQUEST_BYTES + 1) } });
    await expect(readLimitedBody(declared, new AbortController().signal)).rejects.toMatchObject({ httpStatus: 413 });
    const undeclared = new Request("http://localhost", { method: "POST", body: new Uint8Array(MAX_REQUEST_BYTES + 1) });
    await expect(readLimitedBody(undeclared, new AbortController().signal)).rejects.toMatchObject({ httpStatus: 413 });
  });

  it("fits a maximum-sized image and Korean copy below the platform body ceiling", async () => {
    const value = request({ copy: "\uac00".repeat(5000), image: new File([new Uint8Array(MAX_IMAGE_BYTES)], "creative.png", { type: "image/png" }) });
    const serialized = await readLimitedBody(value, new AbortController().signal);
    expect(serialized.byteLength).toBeGreaterThan(MAX_IMAGE_BYTES);
    expect(serialized.byteLength).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
    expect(MAX_REQUEST_BYTES).toBeLessThan(4_500_000);
  });

  it("rejects a file just above the new image limit even when the whole body fits", async () => {
    const image = new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], "oversized.png", { type: "image/png" });
    await expect(parseReviewInput(request({ image }), new AbortController().signal)).rejects.toMatchObject({ httpStatus: 413, issue: { field: "image" } });
  });

  it("rejects duplicate input fields", async () => {
    const form = new FormData();
    form.append("copy", "one"); form.append("copy", "two");
    form.append("publicationDate", "2026-11-04");
    await expect(parseReviewInput(new Request("http://localhost", { method: "POST", body: form }), new AbortController().signal)).rejects.toMatchObject({ issue: { code: "invalid_input" } });
  });
});
