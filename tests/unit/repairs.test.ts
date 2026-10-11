import assert from "node:assert/strict";
import test from "node:test";
import { AppError, ApiErrorCode } from "../../src/lib/api/errors";
import { apiFailure } from "../../src/lib/api/response";
import { detectImageType } from "../../src/features/repairs/repair-photo-service";
import { isRepairTransitionAllowed } from "../../src/features/repairs/repair-state";
import {
  normalizeDraftFields,
  validateDraftFields,
  validateSubmission,
} from "../../src/features/repairs/repair-validation";
import { repairFieldLimits } from "../../src/config/repairs";
import {
  RepairResult,
  RepairStatus,
  RepairTimelineEventType,
  type RepairDraftFields,
} from "../../src/types/contracts";
import { parseRepairListStatus } from "../../src/features/repairs/repair-http";
import { listWhere } from "../../src/features/repairs/repair-query-service";
import { toRepairView } from "../../src/features/repairs/repair-view";

/** 管理端维修列表的筛选：日期走 DATE 列边界，结束日必须含全天（与 issue #75 同源）。 */
test("维修列表日期筛选：DATE 列边界 + 结束日含全天", () => {
  const actor = { userId: "u1", permissions: ["repair:review"] as const };
  const where = listWhere(
    { page: 1, pageSize: 20, repairDateFrom: "2026-09-30", repairDateTo: "2026-09-30" },
    actor,
  );
  const range = where.repairDate as { gte?: Date; lt?: Date; lte?: Date };
  assert.equal(range.gte?.toISOString(), "2026-09-30T00:00:00.000Z");
  assert.equal(
    range.lt?.toISOString(),
    "2026-10-01T00:00:00.000Z",
    "结束日含全天 → 次日零点为排他上界",
  );
  assert.equal(range.lte, undefined, "不得再用 lte：它只在 Prisma 按 UTC 截断时才碰巧正确");

  // 日历上不存在的日期必须被拒，而不是生成 Invalid Date 交给数据库
  assert.throws(
    () => listWhere({ page: 1, pageSize: 20, repairDateTo: "2026-02-30" }, actor),
    (e) => e instanceof AppError && e.code === "VALIDATION_FAILED",
  );
});

test("列表搜索词覆盖机主姓名（电话不参与搜索）", () => {
  const actor = { userId: "u1", permissions: ["repair:read"] as const };
  const where = listWhere({ page: 1, pageSize: 20, query: "张三" }, actor);
  const clauses = where.OR as Array<Record<string, unknown>>;
  assert.ok(
    clauses.some((clause) => "ownerName" in clause),
    "搜索词应包含 ownerName 条件",
  );
  assert.ok(
    clauses.every((clause) => !("ownerPhone" in clause)),
    "机主电话不得参与搜索",
  );
});

test("M2 公共枚举与错误码已冻结", () => {
  assert.deepEqual(RepairStatus, ["DRAFT", "PENDING", "APPROVED", "REJECTED"]);
  assert.deepEqual(RepairResult, ["COMPLETED", "NOT_COMPLETED"]);
  assert.equal(RepairTimelineEventType.includes("FLAG_CHANGED"), true);
  for (const code of [
    "MEMBER_REQUIRED",
    "REPAIR_NOT_FOUND",
    "REPAIR_VERSION_CONFLICT",
    "REPAIR_PHOTO_STORAGE_FAILED",
  ])
    assert.equal(ApiErrorCode.includes(code as never), true);
});
test("维修状态机只接受任务书规定流转", () => {
  assert.equal(isRepairTransitionAllowed("DRAFT", "PENDING"), true);
  assert.equal(isRepairTransitionAllowed("REJECTED", "PENDING"), true);
  assert.equal(isRepairTransitionAllowed("PENDING", "APPROVED"), true);
  assert.equal(isRepairTransitionAllowed("PENDING", "REJECTED"), true);
  assert.equal(isRepairTransitionAllowed("APPROVED", "DRAFT"), false);
  assert.equal(isRepairTransitionAllowed("DRAFT", "APPROVED"), false);
});
test("提交完整性：日期、时长、分类、机主姓名与电话必填；正文与照片不再是门槛", () => {
  const complete = {
    repairDate: new Date("2026-09-15T00:00:00.000Z"),
    durationMinutes: 45,
    categoryId: "category",
    ownerName: "张三",
    ownerPhone: "13800138000",
    content: null,
    result: "COMPLETED",
  };
  // 无正文、无照片即可通过（issue #79 第 6 项：正文与照片退出提交门槛）。
  validateSubmission(complete);

  assert.throws(
    () =>
      validateSubmission({
        repairDate: null,
        durationMinutes: null,
        categoryId: null,
        ownerName: null,
        ownerPhone: null,
        content: null,
        result: null,
      }),
    (e) => e instanceof AppError && e.code === "REPAIR_SUBMISSION_INCOMPLETE",
  );
  // 机主姓名 / 电话必填（issue #79 第 6 项）：缺哪项报哪项的 fieldErrors。
  for (const [field, patch] of [
    ["ownerName", { ownerName: null }],
    ["ownerPhone", { ownerPhone: null }],
  ] as const) {
    assert.throws(
      () => validateSubmission({ ...complete, ...patch }),
      (e) =>
        e instanceof AppError &&
        e.code === "REPAIR_SUBMISSION_INCOMPLETE" &&
        e.fieldErrors?.[field] !== undefined,
      `缺 ${field} 应报 REPAIR_SUBMISSION_INCOMPLETE 并定位到 ${field}`,
    );
  }
  // 电话必须是 11 位大陆手机号。
  assert.throws(
    () => validateSubmission({ ...complete, ownerPhone: "12345678901" }),
    (e) =>
      e instanceof AppError &&
      e.code === "REPAIR_SUBMISSION_INCOMPLETE" &&
      e.fieldErrors?.ownerPhone !== undefined,
  );
  // 维修时长提交必填（issue #72）：其余项齐了但缺时长要拦下。
  assert.throws(
    () => validateSubmission({ ...complete, durationMinutes: null }),
    (e) =>
      e instanceof AppError &&
      e.code === "REPAIR_SUBMISSION_INCOMPLETE" &&
      e.fieldErrors?.durationMinutes !== undefined,
  );
  // 时长越界与小数同样拒绝：草稿阶段的上下限在提交口径里继续生效。
  for (const durationMinutes of [0, 10081, 45.5]) {
    assert.throws(
      () => validateSubmission({ ...complete, durationMinutes }),
      (e) => e instanceof AppError && e.code === "REPAIR_SUBMISSION_INCOMPLETE",
      `${durationMinutes} 分钟应当被拒绝`,
    );
  }
  // `content` 不再是提交必填，但带了超长正文仍要拦（管理员历史数据修正路径）。
  assert.throws(
    () => validateSubmission({ ...complete, content: "字".repeat(10001) }),
    (e) => e instanceof AppError && e.code === "REPAIR_SUBMISSION_INCOMPLETE",
  );
  assert.throws(() => validateDraftFields({ durationMinutes: 10081 }), AppError);
});

test("草稿校验：机主字段可空，填了则受上限与格式约束；电话按存储口径归一", () => {
  // 草稿允许机主姓名 / 电话为空（与日期 / 时长同思路）。
  validateDraftFields({});
  validateDraftFields({ ownerName: null, ownerPhone: null });
  // 姓名超长与非法电话在保存草稿阶段就要拦下。
  assert.throws(
    () => validateDraftFields({ ownerName: "名".repeat(41) }),
    (e) =>
      e instanceof AppError &&
      e.code === "VALIDATION_FAILED" &&
      e.fieldErrors?.ownerName !== undefined,
  );
  assert.throws(
    () => validateDraftFields({ ownerPhone: "1380013800" }),
    (e) =>
      e instanceof AppError &&
      e.code === "VALIDATION_FAILED" &&
      e.fieldErrors?.ownerPhone !== undefined,
  );
  // 归一：姓名 trim、电话剔除非数字、空串落 null。
  assert.equal(normalizeDraftFields({ ownerName: " 张三 " }).ownerName, "张三");
  assert.equal(normalizeDraftFields({ ownerName: "   " }).ownerName, null);
  assert.equal(normalizeDraftFields({ ownerPhone: "138-0013-8000" }).ownerPhone, "13800138000");
  assert.equal(normalizeDraftFields({ ownerPhone: "" }).ownerPhone, null);
  assert.equal(normalizeDraftFields({}).ownerName, undefined, "未提交的字段保持 undefined（不动）");
});

test("维修日期上下限在保存草稿时就生效，而不是等到提交", () => {
  const future = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString().slice(0, 10);
  for (const repairDate of ["2019-12-31", future]) {
    assert.throws(
      () => validateDraftFields({ repairDate }),
      (e) => e instanceof AppError && e.code === "VALIDATION_FAILED",
      `${repairDate} 应当被拒绝`,
    );
  }
  // 边界：下限当天与今天都合法。
  validateDraftFields({ repairDate: repairFieldLimits.repairDateMin });
  validateDraftFields({ repairDate: new Date().toISOString().slice(0, 10) });
});

test("草稿字段错误直接说明字段与原因，仅读取 message 的表单也能定位", () => {
  const cases: Array<[RepairDraftFields, keyof RepairDraftFields, string]> = [
    [{ repairDate: "无效日期" }, "repairDate", "维修日期格式无效"],
    [{ repairDate: "2019-12-31" }, "repairDate", "维修日期不得早于 2020-01-01"],
    [{ repairDate: "9999-12-31" }, "repairDate", "维修日期不能晚于今天"],
    ...[0, 10081, 45.5].map(
      (durationMinutes): [RepairDraftFields, keyof RepairDraftFields, string] => [
        { durationMinutes },
        "durationMinutes",
        "维修时长须为 1–10080 分钟的整数",
      ],
    ),
    [{ ownerName: "名".repeat(41) }, "ownerName", "机主姓名不能超过 40 字"],
    [{ ownerPhone: "1380013800" }, "ownerPhone", "机主电话须为 11 位中国大陆手机号"],
    [{ content: "字".repeat(10001) }, "content", "维修内容不能超过 10000 字"],
    [{ remark: "字".repeat(2001) }, "remark", "备注不能超过 2000 字"],
    [{ result: "INVALID" as RepairResult }, "result", "维修结果无效"],
  ];
  for (const [input, field, message] of cases) {
    assert.throws(
      () => validateDraftFields(input),
      (error) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, "VALIDATION_FAILED");
        assert.equal(error.message, message);
        assert.deepEqual(error.fieldErrors, { [field]: [message] });
        return true;
      },
      field,
    );
  }
});

test("多项草稿错误在 API message 中一起返回，并保留字段映射", async () => {
  let error: unknown;
  try {
    validateDraftFields({ durationMinutes: 0, ownerPhone: "123", remark: "字".repeat(2001) });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof AppError);
  const response = apiFailure(error, "req_repair_validation");
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.success, false);
  assert.equal(body.error.code, "VALIDATION_FAILED");
  assert.equal(
    body.error.message,
    "维修时长须为 1–10080 分钟的整数；机主电话须为 11 位中国大陆手机号；备注不能超过 2000 字",
  );
  assert.deepEqual(body.error.fieldErrors, {
    durationMinutes: ["维修时长须为 1–10080 分钟的整数"],
    ownerPhone: ["机主电话须为 11 位中国大陆手机号"],
    remark: ["备注不能超过 2000 字"],
  });
});

test("提交缺项与非法电话的 message 同样说明具体字段", () => {
  const complete = {
    repairDate: new Date("2026-09-15T00:00:00.000Z"),
    durationMinutes: 45,
    categoryId: "category",
    ownerName: "张三",
    ownerPhone: "13800138000",
    content: null,
    result: "COMPLETED",
  };
  const cases = [
    [{ repairDate: null }, "请填写维修日期"],
    [{ durationMinutes: null }, "请填写维修时长"],
    [{ categoryId: null }, "请选择故障分类"],
    [{ ownerName: null }, "请填写机主姓名"],
    [{ ownerPhone: null }, "请填写机主电话"],
    [{ ownerPhone: "12345678901" }, "机主电话须为 11 位中国大陆手机号"],
    [{ result: null }, "维修结果缺失"],
    [{ ownerName: null, ownerPhone: null }, "请填写机主姓名；请填写机主电话"],
  ] as const;
  for (const [patch, message] of cases) {
    assert.throws(
      () => validateSubmission({ ...complete, ...patch }),
      (error) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, "REPAIR_SUBMISSION_INCOMPLETE");
        assert.equal(error.message, message);
        assert.equal(
          Object.values(error.fieldErrors ?? {})
            .flat()
            .join("；"),
          message,
        );
        return true;
      },
    );
  }
});
test("图片魔数拒绝伪造 MIME 并识别 JPEG PNG WebP", () => {
  assert.equal(detectImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0x00])), "image/jpeg");
  assert.equal(
    detectImageType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    "image/png",
  );
  assert.equal(
    detectImageType(Uint8Array.from([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")])),
    "image/webp",
  );
  assert.equal(detectImageType(Uint8Array.from(Buffer.from("not-an-image"))), null);
});

test("维修列表 status 查询白名单：合法预选，非法忽略", () => {
  assert.equal(parseRepairListStatus("REJECTED"), "REJECTED");
  assert.equal(parseRepairListStatus("DRAFT"), "DRAFT");
  assert.equal(parseRepairListStatus("PENDING"), "PENDING");
  assert.equal(parseRepairListStatus("APPROVED"), "APPROVED");
  assert.equal(parseRepairListStatus(""), "");
  assert.equal(parseRepairListStatus(null), "");
  assert.equal(parseRepairListStatus(undefined), "");
  assert.equal(parseRepairListStatus("DONE"), "");
  assert.equal(parseRepairListStatus("rejected"), "");
});

/** `toRepairView` 只消费记录行的一部分字段；夹具用最小形状 + 断言里的 cast。 */
function recordRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "r1",
    memberProfile: {
      id: "m1",
      nickname: null,
      realName: "张三",
      userId: "u1",
      user: { displayName: null },
    },
    repairDate: new Date("2026-09-15T00:00:00.000Z"),
    durationMinutes: 45,
    category: null,
    deviceModel: null,
    ownerName: "李雷",
    ownerPhone: "13800138000",
    content: null,
    result: "COMPLETED",
    remark: null,
    status: "APPROVED",
    isDifficult: false,
    isTypical: false,
    version: 1,
    submittedAt: null,
    reviewedAt: null,
    createdAt: new Date("2026-09-15T01:00:00.000Z"),
    updatedAt: new Date("2026-09-15T01:00:00.000Z"),
    photos: [],
    ...overrides,
  } as unknown as Parameters<typeof toRepairView>[0];
}

test("机主电话可见性 fail-closed：默认不下发，显式放行才给完整号", () => {
  const row = recordRow();
  assert.equal(toRepairView(row).ownerPhone, null, "调用方忘了传权限时不得暴露");
  assert.equal(toRepairView(row, {}).ownerPhone, null);
  assert.equal(toRepairView(row, { canViewOwnerPhone: false }).ownerPhone, null);
  assert.equal(toRepairView(row, { canViewOwnerPhone: true }).ownerPhone, "13800138000");
  // 机主姓名不参与收口：任何调用方都拿得到。
  assert.equal(toRepairView(row).ownerName, "李雷");
  assert.equal(toRepairView(row).ownerPhone === "13800138000", false, "不得下发掩码或完整号");
});
