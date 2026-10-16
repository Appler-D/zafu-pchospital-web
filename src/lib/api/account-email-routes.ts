import { accountEmailService } from "@/features/email/account-email-service";
import { AppError } from "@/lib/api/errors";
import { apiFailure, apiSuccess } from "@/lib/api/response";
import { getRequestId } from "@/lib/api/request-id";
import {
  assertSameOrigin,
  authenticateRequest,
  requestContext,
  sessionCookie,
} from "@/lib/auth/request";
import { requirePermission } from "@/lib/auth/permissions";
import type {
  AccountEmailChallengeInput,
  AccountEmailConfirmInput,
  EmailCodeInput,
} from "@/types/contracts";

const PRIVATE = { "Cache-Control": "private, no-store" };
function invalid(): never {
  throw new AppError("VALIDATION_FAILED", "请求字段或操作模式无效");
}
export function emailObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function text(body: Record<string, unknown>, key: string, max = 191): string {
  const value = body[key];
  if (typeof value !== "string" || !value || value.length > max) invalid();
  return value;
}
function keys(body: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(body).some((k) => !allowed.includes(k))) invalid();
}
function proof(value: unknown): EmailCodeInput {
  const b = emailObject(value);
  keys(b, ["challengeId", "code"]);
  const challengeId = text(b, "challengeId", 36),
    code = text(b, "code", 6);
  if (!/^[0-9a-f-]{36}$/i.test(challengeId) || !/^\d{6}$/.test(code)) invalid();
  return { challengeId, code };
}
export function parseEmailChallenge(value: unknown): AccountEmailChallengeInput {
  const b = emailObject(value);
  switch (b.mode) {
    case "BIND":
      keys(b, ["mode", "targetEmail"]);
      return { mode: b.mode, targetEmail: text(b, "targetEmail") };
    case "OLD":
      keys(b, ["mode", "currentPassword"]);
      return { mode: b.mode, currentPassword: text(b, "currentPassword", 256) };
    case "NEW":
      keys(b, ["mode", "targetEmail", "currentPassword", "old"]);
      return {
        mode: b.mode,
        targetEmail: text(b, "targetEmail"),
        currentPassword: text(b, "currentPassword", 256),
        old: proof(b.old),
      };
    case "ASSISTED":
      keys(b, ["mode", "assistanceId", "currentPassword"]);
      return {
        mode: b.mode,
        assistanceId: text(b, "assistanceId", 36),
        currentPassword: text(b, "currentPassword", 256),
      };
    default:
      return invalid();
  }
}
export function parseEmailConfirm(value: unknown): AccountEmailConfirmInput {
  const b = emailObject(value);
  const returnTo = b.returnTo === undefined ? undefined : text(b, "returnTo", 500);
  if (b.mode === "BIND") {
    keys(b, ["mode", "targetEmail", "proof", "returnTo"]);
    return { mode: b.mode, targetEmail: text(b, "targetEmail"), proof: proof(b.proof), returnTo };
  }
  if (b.mode === "CHANGE") {
    keys(b, ["mode", "targetEmail", "proof", "returnTo", "currentPassword", "old"]);
    return {
      mode: b.mode,
      targetEmail: text(b, "targetEmail"),
      proof: proof(b.proof),
      currentPassword: text(b, "currentPassword", 256),
      old: proof(b.old),
      returnTo,
    };
  }
  if (b.mode === "ASSISTED") {
    keys(b, ["mode", "assistanceId", "proof", "returnTo", "currentPassword"]);
    return {
      mode: b.mode,
      assistanceId: text(b, "assistanceId", 36),
      proof: proof(b.proof),
      currentPassword: text(b, "currentPassword", 256),
      returnTo,
    };
  }
  return invalid();
}
export async function accountEmailRoute(
  request: Request,
  action: "state" | "challenge" | "confirm",
) {
  const requestId = getRequestId(request.headers);
  try {
    if (action !== "state") assertSameOrigin(request);
    const { token } = await authenticateRequest(request, requestId);
    const ctx = requestContext(request, requestId);
    if (action === "state")
      return apiSuccess(await accountEmailService.getState(token), requestId, { headers: PRIVATE });
    const body: unknown = await request.json();
    if (action === "challenge")
      return apiSuccess(
        await accountEmailService.requestChallenge(token, parseEmailChallenge(body), ctx),
        requestId,
        { headers: PRIVATE },
      );
    const result = await accountEmailService.confirm(token, parseEmailConfirm(body), ctx);
    const response = apiSuccess({ changed: true, destination: result.destination }, requestId, {
      headers: PRIVATE,
    });
    response.cookies.set(sessionCookie(result.token, result.expiresAt));
    return response;
  } catch (error) {
    return apiFailure(
      error instanceof SyntaxError ? new AppError("VALIDATION_FAILED", "请求格式无效") : error,
      requestId,
    );
  }
}
export type AdminEmailAction =
  "state" | "reveal" | "assist" | "revoke-assistance" | "exempt" | "revoke-exemption";
export async function adminEmailRoute(
  request: Request,
  action: AdminEmailAction,
  userId: string,
  id?: string,
) {
  const requestId = getRequestId(request.headers);
  try {
    if (action !== "state") assertSameOrigin(request);
    const { actor } = await authenticateRequest(request, requestId);
    requirePermission(actor, "member:manage");
    if (action === "state")
      return apiSuccess(await accountEmailService.getAdminState(userId, actor), requestId, {
        headers: PRIVATE,
      });
    if (action === "reveal")
      return apiSuccess(await accountEmailService.reveal(userId, actor), requestId, {
        headers: PRIVATE,
      });
    if (action === "assist" || action === "exempt") {
      const b = emailObject(await request.json());
      if (action === "assist") {
        keys(b, ["targetEmail", "reason"]);
        await accountEmailService.createAssistance(
          userId,
          { targetEmail: text(b, "targetEmail"), reason: text(b, "reason", 500) },
          actor,
        );
      } else {
        keys(b, ["reason", "durationHours"]);
        if (
          b.durationHours !== undefined &&
          (typeof b.durationHours !== "number" || !Number.isInteger(b.durationHours))
        )
          invalid();
        await accountEmailService.grantExemption(
          userId,
          { reason: text(b, "reason", 500), durationHours: b.durationHours as number | undefined },
          actor,
        );
      }
    } else if (action === "revoke-assistance")
      await accountEmailService.revokeAssistance(userId, id!, actor);
    else await accountEmailService.revokeExemption(userId, id!, actor);
    return apiSuccess({ changed: true }, requestId, { headers: PRIVATE });
  } catch (error) {
    return apiFailure(
      error instanceof SyntaxError ? new AppError("VALIDATION_FAILED", "请求格式无效") : error,
      requestId,
    );
  }
}
