import { randomBytes } from "node:crypto";
import { crc32 } from "node:zlib";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_IMAGE_BYTES } from "@/lib/review-contract";
import { REQUEST_BUDGET, utf8Length, variantRequestBytes } from "@/lib/transport";
import { verifyContext } from "@/server/evidence-context";
import { MAX_NORMALIZED_BYTES, normalizeImage, parseCreativeForm, parseReviewInput, webpIsLossless } from "@/server/input";
import { reviewWithMeta } from "@/server/meta";
import { createVariant } from "@/server/variant";
import { assessment, assessmentResponse, researchResponse } from "./fixtures";

// Synthetic images carrying marker strings in their metadata. No real photo or location.
beforeEach(() => vi.spyOn(console, "info").mockImplementation(() => undefined));
afterEach(() => vi.restoreAllMocks());

const W = 240, H = 300;
const base = () => sharp({ create: { width: W, height: H, channels: 3, background: "#1a3a4a" } })
  .composite([{ input: { create: { width: 60, height: 40, channels: 3, background: "#f0c040" } }, left: 0, top: 0 }]);

function pngChunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
function withPngText(png: Buffer, marker: string) {
  const end = png.length - 12;
  return Buffer.concat([png.subarray(0, end), pngChunk("tEXt", Buffer.from(`Comment\0${marker}`)),
    pngChunk("iTXt", Buffer.from(`Author\0\0\0\0\0${marker}`)), pngChunk("tIME", Buffer.from([7, 234, 11, 4, 12, 0, 0])), png.subarray(end)]);
}
function pngChunkTypes(png: Buffer) {
  const types: string[] = [];
  for (let offset = 8; offset + 8 <= png.length; offset += 12 + png.readUInt32BE(offset)) types.push(png.toString("ascii", offset + 4, offset + 8));
  return types;
}
function webpChunkTypes(webp: Buffer) {
  const types: string[] = [];
  for (let offset = 12; offset + 8 <= webp.length;) {
    const size = webp.readUInt32LE(offset + 4);
    types.push(webp.toString("ascii", offset, offset + 4));
    offset += 8 + size + (size % 2);
  }
  return types;
}
function jpegMarkersBeforeScan(jpeg: Buffer) {
  const markers: number[] = [];
  for (let offset = 2; offset + 4 <= jpeg.length && jpeg[offset] === 0xff;) {
    const marker = jpeg[offset + 1]!;
    markers.push(marker);
    if (marker === 0xda) break;
    offset += 2 + jpeg.readUInt16BE(offset + 2);
  }
  return markers;
}

async function fixtures() {
  return {
    "JPEG with EXIF GPS at orientation 1": { type: "image/jpeg", marker: "NARAK-GPS-MARK", bytes: await base().jpeg()
      .withExif({ IFD0: { ImageDescription: "NARAK-GPS-MARK", Make: "TestCam" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "37/1 33/1 59/1", GPSLongitudeRef: "E", GPSLongitude: "126/1 58/1 41/1" } }).toBuffer() },
    "JPEG at orientation 6": { type: "image/jpeg", marker: "NARAK-ROT-MARK", bytes: await base().jpeg().withMetadata({ orientation: 6 })
      .withExifMerge({ IFD0: { ImageDescription: "NARAK-ROT-MARK" } }).toBuffer() },
    "PNG with text chunks": { type: "image/png", marker: "NARAK-PNG-MARK", bytes: withPngText(await base().png().toBuffer(), "NARAK-PNG-MARK") },
    "WebP with EXIF": { type: "image/webp", marker: "NARAK-WEBP-MARK", bytes: await base().webp().withExif({ IFD0: { ImageDescription: "NARAK-WEBP-MARK" } }).toBuffer() },
  } as const;
}

function form(fields: Record<string, string>, image: { bytes: Buffer; type: string }) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  body.set("image", new File([new Uint8Array(image.bytes)], "upload", { type: image.type }));
  return new Request("http://localhost/api/review", { method: "POST", body });
}
const decode = (dataUrl: string) => Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");

describe("upload metadata", () => {
  it("the fixtures really carry their markers before upload", async () => {
    for (const [name, image] of Object.entries(await fixtures())) {
      expect(image.bytes.includes(image.marker), name).toBe(true);
    }
    const gps = (await fixtures())["JPEG with EXIF GPS at orientation 1"].bytes;
    expect(gps.includes(Buffer.from([0x25, 0x88])) || gps.includes(Buffer.from([0x88, 0x25]))).toBe(true);
  });

  it("never reaches Muse Spark, SAM 3.1 or Muse Image, for every format", async () => {
    for (const [name, image] of Object.entries(await fixtures())) {
      const fields = { copy: "Ordinary copy", publicationDate: "2026-12-01" };
      const input = await parseReviewInput(form(fields, image), new AbortController().signal);
      const sent: Array<{ model: string; image: Buffer }> = [];
      const visual = assessment(true, "Ordinary copy"); visual.findings[0]!.visualConcept = "block";
      const box = "<0f>0<|box;x1=0;y1=0;x2=59;y2=39;w=240;h=300|><|mask;x=0;y=0;data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>\n";
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
        const body = JSON.parse(String(init?.body));
        for (const part of [...(body.input?.[0]?.content ?? []), ...(body.images ?? [])]) if (part.image_url) sent.push({ model: body.model, image: decode(part.image_url) });
        if (String(url).endsWith("/images/edits")) return Response.json({ data: [{ b64_json: (await base().png().toBuffer()).toString("base64") }] });
        if (body.model === "sam-3.1") return Response.json({ id: "s", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: name.includes("orientation 6") ? "" : box }] }] });
        return Response.json(body.tools ? researchResponse() : assessmentResponse(visual));
      });
      const review = await reviewWithMeta(input, { apiKey: "k", fetcher, registryRetriever: async () => ({ state: "available", checkedCases: 0, matchedCaseIds: [], evidence: [] }) });
      if (review.state !== "completed") throw new Error(`${name} did not complete`);
      if (review.result.variantContext) {
        // The variant route parses the same upload again, so the signed hash must match.
        const again = await parseCreativeForm(form({ ...fields, context: review.result.variantContext, regionId: "G1", instruction: "Make it blue" }, image),
          new AbortController().signal, { extra: ["context", "regionId", "instruction"] });
        expect(again.input.image!.dataUrl).toBe(input.image!.dataUrl);
        const variant = await createVariant({ input: again.input, context: again.extra.context!, regionId: "G1", instruction: "Make it blue" }, { apiKey: "k", fetcher });
        expect(variant.state, name).toBe("completed");
      }
      const models = new Set(sent.map((item) => item.model));
      expect([...models].sort(), name).toEqual(review.result.variantContext ? ["muse-image-1.0", "muse-spark-1.3", "sam-3.1"] : ["muse-spark-1.3", "sam-3.1"]);
      expect(sent.length, name).toBeGreaterThanOrEqual(3);
      for (const item of sent) {
        expect(item.image.includes(image.marker), `${name} to ${item.model}`).toBe(false);
        const metadata = await sharp(item.image).metadata();
        expect([metadata.exif, metadata.xmp, metadata.iptc, metadata.icc, metadata.comments], `${name} to ${item.model}`).toEqual([undefined, undefined, undefined, undefined, undefined]);
      }
    }
  });

  it("removes every metadata block at the container level", async () => {
    const all = await fixtures();
    const jpeg = await normalizeImage(all["JPEG with EXIF GPS at orientation 1"].bytes, "image/jpeg");
    // Only SOI-adjacent JFIF (APP0), tables, frame and scan markers remain. No APP1 to APP15 or COM.
    expect(jpegMarkersBeforeScan(jpeg.bytes).filter((marker) => (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe)).toEqual([]);
    const png = await normalizeImage(all["PNG with text chunks"].bytes, "image/png");
    expect(pngChunkTypes(png.bytes).filter((type) => ["tEXt", "iTXt", "zTXt", "eXIf", "tIME", "iCCP"].includes(type))).toEqual([]);
    const webp = await normalizeImage(all["WebP with EXIF"].bytes, "image/webp");
    expect(webpChunkTypes(webp.bytes).filter((type) => ["EXIF", "XMP ", "ICCP"].includes(type))).toEqual([]);
  });

  it("applies orientation 6, so SAM 3.1 measures the upright grid the browser displays", async () => {
    const rotated = await normalizeImage((await fixtures())["JPEG at orientation 6"].bytes, "image/jpeg");
    expect([rotated.width, rotated.height]).toEqual([H, W]);
    // The yellow block drawn at the top left of the stored pixels moves to the top right.
    const { data, info } = await sharp(rotated.bytes).raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => Array.from(data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3));
    expect(at(H - 10, 10)[0]).toBeGreaterThan(200);
    expect(at(10, 10)[0]).toBeLessThan(60);
  });

  it("converts an embedded color profile to sRGB and drops it", async () => {
    const p3 = await base().withIccProfile("p3").jpeg().toBuffer();
    expect((await sharp(p3).metadata()).icc).toBeDefined();
    const normalized = await normalizeImage(p3, "image/jpeg");
    expect((await sharp(normalized.bytes).metadata()).icc).toBeUndefined();
  });

  it("re-encodes deterministically and keeps a lossless WebP lossless and exact", async () => {
    const png = (await fixtures())["PNG with text chunks"].bytes;
    expect((await normalizeImage(png, "image/png")).bytes.equals((await normalizeImage(png, "image/png")).bytes)).toBe(true);
    const lossless = await base().webp({ lossless: true }).withExif({ IFD0: { ImageDescription: "NARAK-LOSSLESS-MARK" } }).toBuffer();
    expect(webpIsLossless(lossless)).toBe(true);
    const normalized = await normalizeImage(lossless, "image/webp");
    expect(webpIsLossless(normalized.bytes)).toBe(true);
    expect(normalized.bytes.includes("NARAK-LOSSLESS-MARK")).toBe(false);
    const raw = async (value: Buffer) => sharp(value).raw().toBuffer();
    expect((await raw(normalized.bytes)).equals(await raw(lossless))).toBe(true);
    expect(webpIsLossless(await base().webp({ quality: 80 }).toBuffer())).toBe(false);
  });

  it("keeps the worst case inside both budgets", async () => {
    // A noisy, low quality, high pixel count JPEG grows the most when re-encoded.
    const noise = await sharp(randomBytes(2400 * 1800 * 3), { raw: { width: 2400, height: 1800, channels: 3 } }).resize(5000, 3750).jpeg({ quality: 30 }).toBuffer();
    expect(noise.length).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
    const normalized = await normalizeImage(noise, "image/jpeg");
    expect(normalized.bytes.length).toBeGreaterThan(noise.length);
    expect(normalized.bytes.length).toBeLessThanOrEqual(MAX_NORMALIZED_BYTES);
    // The hosting budget covers what the browser sends, which is the original file.
    const longestCopy = "\uce74".repeat(5_000);
    const reviewRequest = MAX_IMAGE_BYTES + utf8Length(longestCopy) + 8_192;
    expect(reviewRequest).toBeLessThan(REQUEST_BUDGET);
    expect(variantRequestBytes({ uploadBytes: MAX_IMAGE_BYTES, copy: longestCopy, context: "x".repeat(150_000) })).toBeLessThan(REQUEST_BUDGET);
    expect(variantRequestBytes({ uploadBytes: MAX_IMAGE_BYTES, copy: longestCopy, context: "x".repeat(200_000) })).toBeGreaterThan(REQUEST_BUDGET);
  });

  it("binds the signed context to the re-encoded bytes", async () => {
    const image = (await fixtures())["JPEG with EXIF GPS at orientation 1"];
    const first = await parseReviewInput(form({ copy: "", publicationDate: "2026-12-01" }, image), new AbortController().signal);
    const { signContext } = await import("@/server/evidence-context");
    const token = signContext("k", { publicationDate: "2026-12-01", copy: "", imageDataUrl: first.image!.dataUrl, image: { width: W, height: H },
      firstReview: { outcome: "no_supported_concern_found", findings: 0 },
      evidence: { sources: [{ sourceId: "S1", title: "t", citedPassage: "p", evidenceState: "unverified", host: "example.com" }], registry: { state: "available", checkedCases: 0, matchedCaseIds: [], evidence: [] } },
      regions: [{ id: "G1", concept: "block", box: { left: 0, top: 0, right: 60, bottom: 40 } }] })!;
    const second = await parseReviewInput(form({ copy: "", publicationDate: "2026-12-01" }, image), new AbortController().signal);
    expect(verifyContext("k", token, { publicationDate: "2026-12-01", copy: "", imageDataUrl: second.image!.dataUrl }).regions).toHaveLength(1);
  });
});
