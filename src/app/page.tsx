import { ReviewWorkspace } from "@/components/review-workspace";
import { getModelApiKey } from "@/server/config";

export const dynamic = "force-dynamic";

export default function Home() {
  return <ReviewWorkspace configured={Boolean(getModelApiKey())} />;
}
