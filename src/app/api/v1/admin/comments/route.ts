import { retiredCommentsResponse } from "@/features/community/retired-comments-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return retiredCommentsResponse(request);
}
