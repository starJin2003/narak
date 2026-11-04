import { reviewResponseSchema, type ReviewResponse } from "@/lib/review-contract";
import {
  MAX_PROGRESS_EVENTS, REVIEW_STREAM_TYPE, openLine, progressLine, resultLine, type ReviewProgress,
} from "@/lib/review-progress";
import { getModelApiKey } from "@/server/config";
import { parseReviewInput } from "@/server/input";
import { reviewWithMeta } from "@/server/meta";
import { invalidInput, ReviewError } from "@/server/review-error";
import { createReviewDiagnostics } from "@/server/review-diagnostics";
import { fitReviewResponse } from "@/server/transport";
import { clientKey, requestGuard } from "@/server/request-guard";

export const runtime = "nodejs";
// Vercel Fluid Compute allows 300 seconds on Hobby. The review's own 255 second deadline,
// which leaves room for one research retry, plus 10 seconds of upload reading stays under
// this limit, so the route can still return an explicit incomplete response first.
export const maxDuration = 280;

const HEADERS = { "Cache-Control": "no-store, max-age=0" };

function respond(body: ReviewResponse, status: number) {
  return Response.json(reviewResponseSchema.parse(body), { status, headers: HEADERS });
}

function statusFor(result: ReviewResponse): number {
  return result.state === "completed" || result.state === "incomplete" ? 200
    : result.issue.code === "rate_limit" ? 429
    : result.state === "unavailable" ? 503 : 502;
}

// The same reply for an unexpected failure in both reply modes.
function unexpected(): ReviewResponse {
  return { state: "failed", result: null, issue: {
    code: "invalid_input", message: "The review request could not be read. Please check the form and try again.", retryable: true,
  } };
}

export async function POST(request: Request) {
  const diagnostics = createReviewDiagnostics();
  // A completed result that cannot fit the hosting response limit fails closed here.
  function fit(body: ReviewResponse): ReviewResponse {
    const fitted = fitReviewResponse(body);
    if (fitted !== body && fitted.state === "failed") diagnostics.fail("response_too_large");
    return fitted;
  }
  function finish(body: ReviewResponse, status: number) {
    const fitted = fit(body);
    const response = respond(fitted, fitted !== body && fitted.state === "failed" ? 502 : status);
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
    // Only a live review streams. Without credentials the reply is the same JSON as before.
    if (!admitted || !(request.headers.get("accept") ?? "").includes(REVIEW_STREAM_TYPE)) {
      try {
        const result = await reviewWithMeta(input, { signal: request.signal, diagnostics });
        return finish(result, statusFor(result));
      } finally { admitted?.release(); }
    }
    // Streamed reply. Every check above already ran, so its own status codes still apply.
    // The stream carries stage events and then exactly one final result, which passes the
    // same schema and size budget as the JSON reply. A stream that ends without that line
    // is shown as a failure by the client.
    const stop = new AbortController();
    const signal = AbortSignal.any([request.signal, stop.signal]);
    const encoder = new TextEncoder();
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const write = (text: string) => { try { controller.enqueue(encoder.encode(text)); } catch { /* The client left. */ } };
        write(openLine());
        let body: ReviewResponse;
        try {
          body = await reviewWithMeta(input, { signal, diagnostics, onProgress: (event: ReviewProgress) => {
            if (sent >= MAX_PROGRESS_EVENTS || signal.aborted) return;
            sent += 1;
            write(progressLine(event));
          } });
        } catch {
          diagnostics.fail("unexpected_internal");
          body = unexpected();
        } finally { admitted?.release(); }
        const fitted = fit(body);
        diagnostics.finish(fitted);
        write(resultLine(reviewResponseSchema.parse(fitted)));
        try { controller.close(); } catch { /* Already closed by a cancel. */ }
      },
      cancel() { stop.abort(); },
    });
    return new Response(stream, { status: 200, headers: {
      ...HEADERS, "Cache-Control": "no-store, max-age=0, no-transform", "Content-Type": `${REVIEW_STREAM_TYPE}; charset=utf-8`,
      "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff",
    } });
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
    return finish(unexpected(), 400);
  }
}
