import "server-only";
import sharp from "sharp";
import {
  IMAGE_TYPES, MAX_COPY_LENGTH, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS,
  inputFieldsSchema, type ReviewInput,
} from "@/lib/review-contract";
import { invalidInput } from "./review-error";

export const MAX_REQUEST_BYTES = MAX_IMAGE_BYTES + 64 * 1024;

// Enforce the limit while reading, including requests without Content-Length.
export async function readLimitedBody(request: Request, signal: AbortSignal): Promise<Buffer> {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_REQUEST_BYTES)) {
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
      if (size > MAX_REQUEST_BYTES) {
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
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    throw invalidInput("Submit the review using the advertisement form.");
  }
  const bytes = await readLimitedBody(request, signal);
  let form: FormData;
  try {
    form = await new Response(new Uint8Array(bytes), { headers: { "content-type": contentType } }).formData();
  } catch {
    throw invalidInput("The upload could not be read. Select the image again and retry.");
  }
  for (const key of form.keys()) {
    if (!["copy", "publicationDate", "market", "image"].includes(key) || form.getAll(key).length !== 1) {
      throw invalidInput("The review form contains unexpected or repeated fields.");
    }
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
  if (!image) return fields.data;
  if (image.size > MAX_IMAGE_BYTES) throw invalidInput("Choose an image up to 4 MB.", "image", 413);
  if (!IMAGE_TYPES.includes(image.type as typeof IMAGE_TYPES[number])) {
    throw invalidInput("Use a JPEG, PNG, or WebP image.", "image");
  }
  const imageBytes = Buffer.from(await image.arrayBuffer());
  try {
    const decoded = sharp(imageBytes, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: "warning" });
    const metadata = await decoded.metadata();
    const expected = { "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp" };
    if (metadata.format !== expected[image.type as keyof typeof expected] || (metadata.pages ?? 1) > 1) {
      throw new Error("Unsupported image");
    }
    await decoded.stats();
  } catch {
    throw invalidInput("This image could not be read. Use a still JPEG, PNG, or WebP under 20 megapixels.", "image");
  }
  signal.throwIfAborted();
  return {
    ...fields.data,
    image: {
      mediaType: image.type as typeof IMAGE_TYPES[number],
      dataUrl: `data:${image.type};base64,${imageBytes.toString("base64")}`,
    },
  };
}
