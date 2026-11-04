import { reviewResponseSchema, type ReviewResponse } from "@/lib/review-contract";
import { getModelApiKey } from "@/server/config";
import { parseReviewInput } from "@/server/input";
import { reviewWithMeta } from "@/server/meta";
import { invalidInput, ReviewError } from "@/server/review-error";
import { createReviewDiagnostics } from "@/server/review-diagnostics";
import { fitReviewResponse } from "@/server/transport";
import { clientKey, requestGuard } from "@/server/request-guard";

export const runtime = "nodejs";
// Vercel Fluid Compute allows 300 seconds on Hobby. The review's own 230 second deadline,
// which leaves room for one research retry, plus 10 seconds of upload reading stays under
// this limit, so the route can still return an explicit incomplete response first.
export const maxDuration = 250;

function respond(body: ReviewResponse, status: number) {
  return Response.json(reviewResponseSchema.parse(body), {
    status,
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

export async function POST(request: Request) {
  const diagnostics = createReviewDiagnostics();
  function finish(body: ReviewResponse, status: number) {
    // A completed result that cannot fit the hosting response limit fails closed here.
    const fitted = fitReviewResponse(body);
    if (fitted !== body && fitted.state === "failed") { diagnostics.fail("response_too_large"); status = 502; }
    const response = respond(fitted, status);
    diagnostics.finish(fitted);
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
    // Only a request that will spend Meta credits counts against the request bounds.
    const admitted = getModelApiKey() ? requestGuard.admit("review", clientKey(request)) : null;
    if (admitted && "issue" in admitted) {
      diagnostics.fail("request_rate_limited");
      return finish({ state: "unavailable", result: null, issue: admitted.issue }, 429);
    }
    try {
      const result = await reviewWithMeta(input, { signal: request.signal, diagnostics });
      const status = result.state === "completed" || result.state === "incomplete" ? 200
        : result.issue.code === "rate_limit" ? 429
        : result.state === "unavailable" ? 503 : 502;
      return finish(result, status);
    } finally { admitted?.release(); }
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
