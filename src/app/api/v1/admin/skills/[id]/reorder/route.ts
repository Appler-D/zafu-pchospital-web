import { bodyOneOf } from "@/features/admin/admin-http";
import { skillAdminService } from "@/features/skills/skill-admin-service";
import { apiFailure, apiSuccess } from "@/lib/api/response";
import { getRequestId } from "@/lib/api/request-id";
import { assertSameOrigin, authenticateRequest } from "@/lib/auth/request";
import { ReorderDirection } from "@/types/contracts";

export const runtime = "nodejs";

/** 将技能标签上移或下移一位；位于边界时幂等成功。 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = getRequestId(request.headers);
  try {
    assertSameOrigin(request);
    const { actor } = await authenticateRequest(request, requestId);
    const body = (await request.json()) as Record<string, unknown>;
    await skillAdminService.reorder(
      (await params).id,
      bodyOneOf(body, "direction", ReorderDirection),
      actor,
    );
    return apiSuccess({ reordered: true }, requestId);
  } catch (error) {
    return apiFailure(error, requestId);
  }
}
