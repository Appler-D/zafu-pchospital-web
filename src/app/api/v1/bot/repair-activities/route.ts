import { managementService } from "@/features/management/management-service";
import { parseCreate, readMachineBody, requireUuid } from "@/features/management/management-input";
import { apiFailure, apiSuccess } from "@/lib/api/response";
import { getRequestId } from "@/lib/api/request-id";
import { authenticateMachine } from "@/lib/auth/machine";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const requestId = getRequestId(request.headers);
  try {
    const actor = authenticateMachine(request, requestId, "activity:create");
    const operationId = requireUuid(request.headers.get("idempotency-key"));
    const input = parseCreate(await readMachineBody(request));
    return apiSuccess(await managementService.create(input, operationId, actor), requestId, {
      status: 201,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiFailure(error, requestId);
  }
}
