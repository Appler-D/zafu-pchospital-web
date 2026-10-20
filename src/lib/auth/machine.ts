import { createHash, timingSafeEqual } from "node:crypto";

import { AppError } from "@/lib/api/errors";
import { requestContext } from "@/lib/auth/request";
import type { AuthorizedActor } from "@/types/contracts";

export const machineScopes = ["activity:read", "activity:create", "activity:update"] as const;
export type MachineScope = (typeof machineScopes)[number];
export type MachineActor = AuthorizedActor & {
  actorType: "SYSTEM";
  principalId: "management-whale";
  scopes: readonly MachineScope[];
  requestedBy: string;
  groupOrigin: string;
};

/** Dedicated machine routes only. No Cookie fallback and no ADMIN/user impersonation. */
export function authenticateMachine(
  request: Request,
  requestId: string,
  scope: MachineScope,
): MachineActor {
  const expected = process.env.MANAGEMENT_BOT_TOKEN_SHA256 ?? "";
  const expiry = Date.parse(process.env.MANAGEMENT_BOT_TOKEN_EXPIRES_AT ?? "");
  const origin = process.env.MANAGEMENT_BOT_ORIGIN ?? "";
  if (!/^[a-f0-9]{64}$/.test(expected) || !Number.isFinite(expiry) || !origin) {
    throw new AppError("INTERNAL_ERROR", "管理机器人接口未启用", { status: 503 });
  }
  const match = /^Bearer ([A-Za-z0-9_-]{40,128})$/.exec(request.headers.get("authorization") ?? "");
  if (
    !match ||
    expiry <= Date.now() ||
    !timingSafeEqual(createHash("sha256").update(match[1]).digest(), Buffer.from(expected, "hex"))
  ) {
    throw new AppError("UNAUTHENTICATED", "机器凭证无效或已过期");
  }
  const requestedBy = request.headers.get("x-management-actor") ?? "";
  if (
    request.headers.get("x-management-origin") !== origin ||
    !/^[A-Fa-f0-9]{32}$/.test(requestedBy)
  ) {
    throw new AppError("FORBIDDEN", "管理会话来源无效");
  }
  const actor: MachineActor = {
    ...requestContext(request, requestId),
    actorType: "SYSTEM",
    userStatus: "ACTIVE",
    permissions: [],
    principalId: "management-whale",
    scopes: machineScopes,
    requestedBy,
    groupOrigin: origin,
  };
  return requireMachineScope(actor, scope);
}

export function requireMachineScope(actor: MachineActor, scope: MachineScope): MachineActor {
  if (
    actor.actorType !== "SYSTEM" ||
    actor.principalId !== "management-whale" ||
    !actor.scopes.includes(scope)
  ) {
    throw new AppError("FORBIDDEN", "机器操作未获授权");
  }
  return actor;
}

/** Values are asserted by the authenticated integration, not QQ text supplied to the model. */
export function integrationAudit(actor: AuthorizedActor): Record<string, string> {
  const machine = actor as Partial<MachineActor>;
  return actor.actorType === "SYSTEM" && machine.principalId === "management-whale"
    ? { servicePrincipal: machine.principalId, requestedBy: machine.requestedBy ?? "" }
    : {};
}
