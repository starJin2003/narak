import "server-only";

export const META_API_BASE = "https://api.meta.ai/v1";
export const META_RESPONSES_URL = `${META_API_BASE}/responses`;
export const META_IMAGE_EDITS_URL = `${META_API_BASE}/images/edits`;
export const META_MODEL = "muse-spark-1.3";
// The assessment runs at low reasoning effort (https://dev.meta.ai/docs/reasoning). On
// 2026-11-04 low cut median assessment time from 38 s to 12 s, and both controls that
// reached the assessment were retained.
// Research leaves effort to the model.
export const ASSESSMENT_REASONING_EFFORT = "low";
// Documentation: https://dev.meta.ai/docs/sam/overview
export const SAM_MODEL = "sam-3.1";
// Documentation: https://dev.meta.ai/docs/image-generation
export const MUSE_IMAGE_MODEL = "muse-image-1.0";

export function getModelApiKey(): string | undefined {
  const key = process.env.MODEL_API_KEY?.trim();
  return key && !key.startsWith("replace_with_") ? key : undefined;
}
