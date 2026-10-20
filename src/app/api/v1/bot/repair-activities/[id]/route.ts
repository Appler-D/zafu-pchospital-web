import { managementService } from "@/features/management/management-service";
import {
  parseUpdate,
  parseVersion,
  readMachineBody,
  requireUuid,
} from "@/features/management/management-input";
import { apiFailure, apiSuccess } from "@/lib/api/response";
import { getRequestId } from "@/lib/api/request-id";
import { authenticateMachine } from "@/lib/auth/machine";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  const requestId = getRequestId(request.headers);
  try {
    const actor = authenticateMachine(request, requestId, "activity:read");
    const result = await managementService.detail(requireUuid((await context.params).id), actor);
    return apiSuccess(result, requestId, {
      headers: { "Cache-Control": "private, no-store", ETag: result.version },
    });
  } catch (error) {
    return apiFailure(error, requestId);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const requestId = getRequestId(request.headers);
  try {
    const actor = authenticateMachine(request, requestId, "activity:update");
    const id = requireUuid((await context.params).id);
    const operationId = requireUuid(request.headers.get("idempotency-key"));
    const version = parseVersion(request.headers.get("if-match"));
    const input = parseUpdate(await readMachineBody(request));
    const result = await managementService.update(id, input, version, operationId, actor);
    return apiSuccess(result, requestId, {
      headers: { "Cache-Control": "private, no-store", ETag: result.version },
    });
  } catch (error) {
    return apiFailure(error, requestId);
  }
}
