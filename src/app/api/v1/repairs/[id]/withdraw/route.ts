import { idempotencyKey } from "@/features/repairs/repair-http";
import { repairService } from "@/features/repairs/repair-service";
import { apiFailure, apiSuccess } from "@/lib/api/response";
import { getRequestId } from "@/lib/api/request-id";
import { assertSameOrigin, authenticateRequest } from "@/lib/auth/request";

export const runtime = "nodejs";

/**
 * 撤回审核（issue #165）：创建人把待审核记录退回草稿。
 * 入参与 `submit` 同形（version + Idempotency-Key），审核结论与已通过记录不在此处理。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = getRequestId(request.headers);
  try {
    assertSameOrigin(request);
    const { actor } = await authenticateRequest(request, requestId);
    const body = (await request.json()) as Record<string, unknown>;
    return apiSuccess(
      await repairService.withdraw(
        (await params).id,
        { version: Number(body.version), idempotencyKey: idempotencyKey(request) },
        actor,
      ),
      requestId,
    );
  } catch (error) {
    return apiFailure(error, requestId);
  }
}
