import { queryOneOf, queryString } from "@/features/admin/admin-http";
import { inviteCodeService } from "@/features/invitations/invite-code-service";
import { tableQueryInput } from "@/features/admin/table-http";
import { apiFailure, apiSuccess } from "@/lib/api/response";
import { getRequestId } from "@/lib/api/request-id";
import { assertSameOrigin, authenticateRequest } from "@/lib/auth/request";
import { InviteCodeEffectiveStatus } from "@/types/contracts";
export const runtime = "nodejs";
/** 邀请码分页列表。 */
export async function GET(request: Request) {
  const requestId = getRequestId(request.headers);
  try {
    const { actor } = await authenticateRequest(request, requestId);
    const params = new URL(request.url).searchParams;
    const result = await inviteCodeService.list(
      {
        ...tableQueryInput(params, "invite-codes"),
        status: queryOneOf(params, "status", InviteCodeEffectiveStatus),
        query: queryString(params, "query"),
      },
      actor,
    );
    return apiSuccess(result.items, requestId, {
      pagination: result.pagination,
      summary: result.summary,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiFailure(error, requestId);
  }
}
export async function POST(request: Request) {
  const requestId = getRequestId(request.headers);
  try {
    assertSameOrigin(request);
    const { actor } = await authenticateRequest(request, requestId);
    const body = (await request.json()) as Record<string, unknown>;
    return apiSuccess(
      await inviteCodeService.create(
        {
          activeFrom: optionalDate(body.activeFrom),
          expiresAt: optionalDate(body.expiresAt),
          maxUses: Number(body.maxUses),
          boundQq: optional(body.boundQq),
          boundPhone: optional(body.boundPhone),
        },
        actor,
      ),
      requestId,
      { status: 201 },
    );
  } catch (error) {
    return apiFailure(error, requestId);
  }
}
function optional(value: unknown) {
  return typeof value === "string" ? value : undefined;
}
function optionalDate(value: unknown): string | null | undefined {
  return value === null ? null : optional(value);
}
