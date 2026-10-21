import { retiredCommentsResponse } from "@/features/community/retired-comments-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(request: Request) {
  return retiredCommentsResponse(request, true);
}
