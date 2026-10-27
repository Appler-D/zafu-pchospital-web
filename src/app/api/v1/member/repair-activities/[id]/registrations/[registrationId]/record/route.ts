import { repairActivityStaffService } from "@/features/repair-activities/repair-activity-staff-service";
import { draftInput, idempotencyKey } from "@/features/repairs/repair-http";
import { AppError } from "@/lib/api/errors";
import { apiFailure, apiSuccess } from "@/lib/api/response";
import { getRequestId } from "@/lib/api/request-id";
import { assertSameOrigin, authenticateRequest } from "@/lib/auth/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * 接待补单「提交即建单」：不落草稿，直接创建 PENDING 维修记录并关联登记。
 * 幂等键复用新建表单的会话键（`Idempotency-Key` 头）。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; registrationId: string }> },
) {
  const requestId = getRequestId(request.headers);
  try {
    assertSameOrigin(request);
    const { actor } = await authenticateRequest(request, requestId);
    const { id, registrationId } = await params;
    if (!id || !registrationId || id.length > 36 || registrationId.length > 36) {
      throw new AppError("VALIDATION_FAILED", "活动或报名 ID 无效");
    }
    const body = (await request.json()) as Record<string, unknown>;
    return apiSuccess(
      await repairActivityStaffService.createServeRecord(
        id,
        registrationId,
        { idempotencyKey: idempotencyKey(request), fields: draftInput(body) },
        actor,
      ),
      requestId,
      { status: 201, headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return apiFailure(error, requestId);
  }
}
