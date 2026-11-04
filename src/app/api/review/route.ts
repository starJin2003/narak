import { reviewResponseSchema, type ReviewResponse } from "@/lib/review-contract";
import { parseReviewInput } from "@/server/input";
import { reviewWithMeta } from "@/server/meta";
import { invalidInput, ReviewError } from "@/server/review-error";
import { createReviewDiagnostics } from "@/server/review-diagnostics";

export const runtime = "nodejs";
// Vercel Fluid Compute supports 300 seconds on Hobby. Keep the review's own
// deadline shorter so it can return an explicit incomplete response first.
export const maxDuration = 210;

function respond(body: ReviewResponse, status: number) {
  return Response.json(reviewResponseSchema.parse(body), {
    status,
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

export async function POST(request: Request) {
  const diagnostics = createReviewDiagnostics();
  function finish(body: ReviewResponse, status: number) {
    const response = respond(body, status);
    diagnostics.finish(body);
    return response;
  }
  try {
    const origin = request.headers.get("origin");
    const requestUrl = new URL(request.url);
    // Next.js may use its internal hostname in request.url. The browser's Host
    // header identifies the actual local origin, without trusting forwarded hosts.
    const expectedOrigin = `${requestUrl.protocol}//${request.headers.get("host") ?? requestUrl.host}`;
    if ((origin && origin !== expectedOrigin) || request.headers.get("sec-fetch-site") === "cross-site") {
      throw invalidInput("Open the review form in this workspace to submit a creative.", undefined, 403);
    }
    const inputSignal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]);
    const input = await parseReviewInput(request, inputSignal);
    const result = await reviewWithMeta(input, { signal: request.signal, diagnostics });
    const status = result.state === "completed" || result.state === "incomplete" ? 200
      : result.issue.code === "rate_limit" ? 429
      : result.state === "unavailable" ? 503 : 502;
    return finish(result, status);
  } catch (error) {
    if (error instanceof ReviewError) {
      diagnostics.fail("invalid_input"); return finish(error.toResponse(), error.httpStatus);
    }
    if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) {
      diagnostics.fail(request.signal.aborted ? "client_cancelled" : "review_deadline_exceeded");
      return finish({ state: "incomplete", result: null, issue: {
        code: "timeout", message: "The upload did not finish in time. Please try again.", retryable: true,
      } }, 408);
    }
    diagnostics.fail("unexpected_internal");
    return finish({ state: "failed", result: null, issue: {
      code: "invalid_input", message: "The review request could not be read. Please check the form and try again.", retryable: true,
    } }, 400);
  }
}
