import "server-only";

export const META_RESPONSES_URL = "https://api.meta.ai/v1/responses";
export const META_MODEL = "muse-spark-1.3";

export function getModelApiKey(): string | undefined {
  const key = process.env.MODEL_API_KEY?.trim();
  return key && !key.startsWith("replace_with_") ? key : undefined;
}
