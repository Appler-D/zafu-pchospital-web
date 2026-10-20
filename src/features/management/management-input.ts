import { createHash } from "node:crypto";

import type {
  CreateRepairActivityInput,
  UpdateRepairActivityInput,
} from "@/features/repair-activities/repair-activity-service";
import { bodyRequiredIsoDate } from "@/features/repair-activities/repair-activity-http";
import { AppError } from "@/lib/api/errors";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const createKeys = ["title", "capacity", "activityAt", "signupOpensAt", "signupClosesAt"];

export function requireUuid(value: string | null): string {
  if (!value || !UUID.test(value)) throw new AppError("VALIDATION_FAILED", "需要有效UUID");
  return value.toLowerCase();
}

export function parseVersion(raw: string | null): number {
  const match = /^"([1-9][0-9]*)"$/.exec(raw ?? "");
  if (!match || !Number.isSafeInteger(Number(match[1]))) {
    throw new AppError("VALIDATION_FAILED", "If-Match需要查询返回的活动版本");
  }
  return Number(match[1]);
}

export async function readMachineBody(request: Request): Promise<Record<string, unknown>> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new AppError("VALIDATION_FAILED", "需要JSON请求");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new AppError("VALIDATION_FAILED", "请求内容不能为空");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 8192) {
      await reader.cancel();
      throw new AppError("VALIDATION_FAILED", "请求内容过大", { status: 413 });
    }
    chunks.push(value);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new AppError("VALIDATION_FAILED", "JSON对象格式无效");
  }
}

function fields(body: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new AppError("VALIDATION_FAILED", "含不支持的活动字段");
  }
}

function title(body: Record<string, unknown>): string {
  if (typeof body.title !== "string") throw new AppError("VALIDATION_FAILED", "标题不能为空");
  return body.title.trim();
}

function capacity(body: Record<string, unknown>): number {
  if (typeof body.capacity !== "number" || !Number.isInteger(body.capacity)) {
    throw new AppError("VALIDATION_FAILED", "容量必须是整数");
  }
  return body.capacity;
}

export function parseCreate(body: Record<string, unknown>): CreateRepairActivityInput {
  fields(body, createKeys);
  for (const key of ["activityAt", "signupOpensAt", "signupClosesAt"]) {
    if (typeof body[key] !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/.test(body[key])) {
      throw new AppError("VALIDATION_FAILED", "活动时间需要显式时区");
    }
  }
  return {
    title: title(body),
    capacity: capacity(body),
    activityAt: bodyRequiredIsoDate(body, "activityAt"),
    signupOpensAt: bodyRequiredIsoDate(body, "signupOpensAt"),
    signupClosesAt: bodyRequiredIsoDate(body, "signupClosesAt"),
  };
}

export function parseUpdate(body: Record<string, unknown>): UpdateRepairActivityInput {
  fields(body, ["title", "capacity"]);
  if (Object.keys(body).length === 0) throw new AppError("VALIDATION_FAILED", "需要标题或容量");
  return {
    ...(Object.hasOwn(body, "title") ? { title: title(body) } : {}),
    ...(Object.hasOwn(body, "capacity") ? { capacity: capacity(body) } : {}),
  };
}

export function operationDigest(value: unknown): string {
  function sorted(v: unknown): unknown {
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map(sorted);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => [k, sorted(x)]),
      );
    }
    return v;
  }
  return createHash("sha256")
    .update(JSON.stringify(sorted(value)))
    .digest("hex");
}
