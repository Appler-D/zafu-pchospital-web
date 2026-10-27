import { memberService } from "@/features/members/member-service";
import { apiFailure, apiSuccess } from "@/lib/api/response";
import { getRequestId } from "@/lib/api/request-id";
import { assertSameOrigin, authenticateRequest } from "@/lib/auth/request";

export const runtime = "nodejs";

/** 含账号上下文的最小信息：与「账号恢复」结果一样禁止任何共享缓存。 */
const PRIVATE = { "Cache-Control": "private, no-store" } as const;

export async function POST(request: Request) {
  const requestId = getRequestId(request.headers);
  try {
    assertSameOrigin(request);
    // 恢复工具入口之一：只豁免邮箱门禁（任务 6 §6），权限与 SELF 仍由 Service 二次校验。
    const { actor } = await authenticateRequest(request, requestId, "account-recovery");
    // QQ 只走请求体（核定）：不进 URL / 日志 / 代理访问记录。
    const body = (await request.json()) as Record<string, unknown>;
    return apiSuccess(
      await memberService.lookupAccount({ qq: String(body.qq ?? "") }, actor),
      requestId,
      { headers: PRIVATE },
    );
  } catch (error) {
    return apiFailure(error, requestId);
  }
}
