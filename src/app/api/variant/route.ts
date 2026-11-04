import { REQUEST_BUDGET } from "@/lib/transport";
import { variantResponseSchema, type VariantResponse } from "@/lib/variant-contract";
import { getModelApiKey } from "@/server/config";
import { parseCreativeForm } from "@/server/input";
import { clientKey, requestGuard } from "@/server/request-guard";
import { fitVariantResponse } from "@/server/transport";
import { ReviewError, invalidInput } from "@/server/review-error";
import { createVariant } from "@/server/variant";

export const runtime = "nodejs";
export const maxDuration = 210;

function respond(body: VariantResponse, status: number) {
  const fitted = fitVariantResponse(body);
  return Response.json(variantResponseSchema.parse(fitted), {
    status: fitted !== body && fitted.state === "failed" ? 502 : status, headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin");
    const requestUrl = new URL(request.url);
    const expectedOrigin = `${requestUrl.protocol}//${request.headers.get("host") ?? requestUrl.host}`;
    if ((origin && origin !== expectedOrigin) || request.headers.get("sec-fetch-site") === "cross-site") {
      throw invalidInput("Open the review form in this workspace to request a variant.", undefined, 403);
    }
    const inputSignal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]);
    const { input, extra } = await parseCreativeForm(request, inputSignal, {
      // The same budget the review used when it issued the context, so a request the
      // hosting platform would refuse is never accepted locally either.
      extra: ["context", "regionId", "instruction"], maxBytes: REQUEST_BUDGET,
    });
    const admitted = getModelApiKey() ? requestGuard.admit("variant", clientKey(request)) : null;
    if (admitted && "issue" in admitted) return respond({ state: "unavailable", result: null, issue: admitted.issue }, 429);
    try {
      const result = await createVariant({ input, context: extra.context!, regionId: extra.regionId!, instruction: extra.instruction! }, { signal: request.signal });
      const status = result.state === "completed" || result.state === "incomplete" ? 200
        : result.issue.code === "rate_limit" ? 429
        : result.issue.code === "context_expired" ? 409
        : result.issue.code === "content_policy" ? 422
        : result.issue.code === "invalid_input" ? 400
        : result.state === "unavailable" ? 503 : 502;
      return respond(result, status);
    } finally { admitted?.release(); }
  } catch (error) {
    if (error instanceof ReviewError) return respond({ state: error.state, result: null, issue: error.issue }, error.httpStatus);
    if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) {
      return respond({ state: "incomplete", result: null, issue: {
        code: "timeout", message: "The upload did not finish in time. Please try again.", retryable: true,
      } }, 408);
    }
    return respond({ state: "failed", result: null, issue: {
      code: "invalid_input", message: "The variant request could not be read. Please try again.", retryable: true,
    } }, 400);
  }
}
