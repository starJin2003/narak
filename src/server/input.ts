import "server-only";
import sharp from "sharp";
import {
  IMAGE_TYPES, MAX_COPY_LENGTH, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS,
  inputFieldsSchema, type ReviewInput,
} from "@/lib/review-contract";
import { invalidInput } from "./review-error";

export const MAX_REQUEST_BYTES = MAX_IMAGE_BYTES + 64 * 1024;
const FORM_FIELDS = ["copy", "publicationDate", "market", "image"];

// Enforce the limit while reading, including requests without Content-Length.
export async function readLimitedBody(request: Request, signal: AbortSignal, maxBytes = MAX_REQUEST_BYTES): Promise<Buffer> {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    throw invalidInput("The upload is too large. Choose an image up to 4 MB.", "image", 413);
  }
  if (!request.body) throw invalidInput("Add advertisement copy or an image, and a publication date.");
  const reader = request.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    signal.throwIfAborted();
    while (true) {
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) {
        throw invalidInput("The upload is too large. Choose an image up to 4 MB.", "image", 413);
      }
      chunks.push(part.value);
    }
    return Buffer.concat(chunks);
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function parseReviewInput(request: Request, signal: AbortSignal): Promise<ReviewInput> {
  return (await parseCreativeForm(request, signal)).input;
}

// The variant form carries the same creative plus a few text fields of its own.
export async function parseCreativeForm(request: Request, signal: AbortSignal, options: { extra?: readonly string[]; maxBytes?: number } = {}): Promise<{ input: ReviewInput; extra: Record<string, string> }> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    throw invalidInput("Submit the review using the advertisement form.");
  }
  const bytes = await readLimitedBody(request, signal, options.maxBytes);
  let form: FormData;
  try {
    form = await new Response(new Uint8Array(bytes), { headers: { "content-type": contentType } }).formData();
  } catch {
    throw invalidInput("The upload could not be read. Select the image again and retry.");
  }
  for (const key of form.keys()) {
    if (![...FORM_FIELDS, ...(options.extra ?? [])].includes(key) || form.getAll(key).length !== 1) {
      throw invalidInput("The review form contains unexpected or repeated fields.");
    }
  }
  const extra: Record<string, string> = {};
  for (const key of options.extra ?? []) {
    const value = form.get(key);
    if (typeof value !== "string") throw invalidInput("The request is missing a required field.");
    extra[key] = value;
  }
  const copy = form.get("copy") ?? "";
  const fields = inputFieldsSchema.safeParse({
    // Multipart uses CRLF; restore the textarea's LF convention before counting.
    copy: typeof copy === "string" ? copy.replace(/\r\n?/g, "\n") : copy,
    publicationDate: form.get("publicationDate"),
    market: form.get("market") ?? "KR",
  });
  if (!fields.success) {
    const path = fields.error.issues[0]?.path[0];
    if (path === "copy") throw invalidInput(`Keep advertisement copy to ${MAX_COPY_LENGTH.toLocaleString("en-US")} characters or fewer.`, "copy");
    if (path === "publicationDate") throw invalidInput("Choose a valid publication date.", "publicationDate");
    throw invalidInput("This review supports South Korea only.");
  }
  const image = form.get("image");
  if (image !== null && (!(image instanceof File) || image.size === 0)) {
    throw invalidInput("Choose a nonempty JPEG, PNG, or WebP image.", "image");
  }
  if (!fields.data.copy.trim() && !image) {
    throw invalidInput("Add advertisement copy or an image to begin.", "copy");
  }
  if (!image) return { input: fields.data, extra };
  if (image.size > MAX_IMAGE_BYTES) throw invalidInput("Choose an image up to 4 MB.", "image", 413);
  if (!IMAGE_TYPES.includes(image.type as typeof IMAGE_TYPES[number])) {
    throw invalidInput("Use a JPEG, PNG, or WebP image.", "image");
  }
  const normalized = await normalizeImage(Buffer.from(await image.arrayBuffer()), image.type);
  signal.throwIfAborted();
  return { input: {
    ...fields.data,
    image: {
      mediaType: image.type as typeof IMAGE_TYPES[number],
      dataUrl: `data:${image.type};base64,${normalized.bytes.toString("base64")}`,
      width: normalized.width,
      height: normalized.height,
      uploadBytes: image.size,
    },
  }, extra };
}

// The upload the browser sends is never forwarded as is. Every image is decoded and
// encoded again with sharp, which writes no metadata unless asked. EXIF (including GPS),
// XMP, IPTC, comments, PNG text chunks and ICC profiles therefore never reach a provider,
// and colors are converted to sRGB first. EXIF orientation is applied, so every model call
// and every SAM 3.1 coordinate refers to the upright pixel grid the browser displays. The
// encoding is deterministic, so a variant request that repeats the upload produces the same
// bytes and the same signed hash. Neither the upload nor the re-encoded image is stored.
// The re-encoded image travels only from this server to Meta, whose documented inline image
// limit is 50 MB, never through the hosting body limit. JPEG quality 95 keeps generation
// loss small. The worst case measured, a noisy 18.75 megapixel JPEG at quality 30, grew from
// 3.9 MB to 8.0 MB.
export const MAX_NORMALIZED_BYTES = 12 * 1024 * 1024;

// A lossless WebP stays lossless. RIFF chunks are scanned for the VP8L image chunk.
export function webpIsLossless(bytes: Buffer): boolean {
  if (bytes.length < 20 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") return false;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const type = bytes.toString("ascii", offset, offset + 4);
    if (type === "VP8L") return true;
    if (type === "VP8 ") return false;
    offset += 8 + bytes.readUInt32LE(offset + 4) + (bytes.readUInt32LE(offset + 4) % 2);
  }
  return false;
}

export async function normalizeImage(imageBytes: Buffer, mediaType: string) {
  try {
    const decoded = sharp(imageBytes, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: "warning" });
    const metadata = await decoded.metadata();
    const expected = { "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp" };
    if (metadata.format !== expected[mediaType as keyof typeof expected] || (metadata.pages ?? 1) > 1) {
      throw new Error("Unsupported image");
    }
    await decoded.stats();
    if (!metadata.width || !metadata.height) throw new Error("Unknown dimensions");
    const upright = sharp(imageBytes, { limitInputPixels: MAX_IMAGE_PIXELS }).rotate();
    const encoder = metadata.format === "jpeg" ? upright.jpeg({ quality: 95 })
      : metadata.format === "png" ? upright.png({ compressionLevel: 9 })
      : upright.webp(webpIsLossless(imageBytes) ? { lossless: true } : { quality: 95 });
    const output = await encoder.toBuffer({ resolveWithObject: true });
    if (output.data.byteLength > MAX_NORMALIZED_BYTES) throw new Error("Re-encoded image too large");
    return { bytes: output.data, width: output.info.width, height: output.info.height };
  } catch {
    throw invalidInput("This image could not be read. Use a still JPEG, PNG, or WebP under 20 megapixels.", "image");
  }
}
