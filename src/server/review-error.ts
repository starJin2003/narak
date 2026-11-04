import "server-only";
import type { ReviewIssue, ReviewResponse } from "@/lib/review-contract";

export class ReviewError extends Error {
  constructor(
    readonly state: "incomplete" | "unavailable" | "failed",
    readonly issue: ReviewIssue,
    readonly httpStatus = 502,
  ) {
    super(issue.message);
    this.name = "ReviewError";
  }

  toResponse(): ReviewResponse {
    return { state: this.state, result: null, issue: this.issue };
  }
}

export function invalidInput(message: string, field?: ReviewIssue["field"], status = 400) {
  return new ReviewError("failed", { code: "invalid_input", message, retryable: false, field }, status);
}

export function invalidResponse() {
  return new ReviewError("failed", {
    code: "invalid_response",
    message: "The review service returned an unusable response. No assessment was issued. Please try again.",
    retryable: true,
  });
}

export function incomplete(code: "retrieval_incomplete" | "insufficient_sources" | "assessment_incomplete", message: string) {
  return new ReviewError("incomplete", { code, message, retryable: true }, 200);
}
