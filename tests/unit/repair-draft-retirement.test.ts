import assert from "node:assert/strict";
import test from "node:test";

import {
  planDraftRetirement,
  summarizeDraftRetirement,
  type DraftRetirementCategoryLookup,
  type DraftRetirementRecord,
  type DraftRetirementRegistration,
} from "../../src/features/repairs/repair-draft-retirement";

const CATEGORIES: DraftRetirementCategoryLookup = {
  activeIds: new Set(["cat-system", "cat-cool"]),
  activeIdByCode: new Map([
    ["SYSTEM", "cat-system"],
    ["COOLING_CLEANING", "cat-cool"],
  ]),
};

function baseRecord(overrides: Partial<DraftRetirementRecord> = {}): DraftRetirementRecord {
  return {
    id: "record-manual",
    version: 3,
    createRequestKey: "manual:key",
    result: "COMPLETED",
    repairDate: new Date("2026-10-01T00:00:00.000Z"),
    durationMinutes: 30,
    categoryId: "cat-system",
    ownerName: "李四",
    ownerPhone: "13900002222",
    deviceModel: "X1 Carbon",
    content: null,
    submittedAt: null,
    registration: null,
    ...overrides,
  };
}

function registration(
  overrides: Partial<DraftRetirementRegistration> = {},
): DraftRetirementRegistration {
  return {
    id: "registration-1",
    name: "张三",
    phone: "13900001111",
    deviceModel: "小新 Pro",
    issueType: "SOFTWARE_SYSTEM",
    activityAt: new Date("2026-09-20T02:00:00.000Z"),
    ...overrides,
  };
}

test("活动草稿：缺失字段从报名 / 活动回填后可补提", () => {
  const [item] = planDraftRetirement(
    [
      baseRecord({
        id: "record-activity",
        createRequestKey: "activity-serve:registration-1",
        repairDate: null,
        categoryId: null,
        ownerName: null,
        ownerPhone: null,
        deviceModel: null,
        registration: registration(),
      }),
    ],
    CATEGORIES,
    { withdrawnMode: null },
  );
  assert.equal(item.action, "submit");
  assert.equal(item.eligibleToSubmit, true);
  assert.equal(item.source, "activity");
  assert.deepEqual(item.patch, {
    ownerName: "张三",
    ownerPhone: "13900001111",
    deviceModel: "小新 Pro",
    repairDate: new Date("2026-09-20T00:00:00.000Z"),
    categoryId: "cat-system",
  });
  assert.deepEqual(item.changedFields, [
    "ownerName",
    "ownerPhone",
    "deviceModel",
    "repairDate",
    "categoryId",
  ]);
  assert.deepEqual(item.categoryRemapped, { from: null, toCode: "SYSTEM" });
  assert.deepEqual(item.voidReasons, []);
  assert.equal(item.registrationId, "registration-1");
});

test("手工草稿：字段完整时原样补提，不改任何字段", () => {
  const [item] = planDraftRetirement([baseRecord()], CATEGORIES, { withdrawnMode: null });
  assert.equal(item.action, "submit");
  assert.equal(item.source, "manual");
  assert.deepEqual(item.patch, {});
  assert.deepEqual(item.changedFields, []);
  assert.deepEqual(item.missingBefore, []);
});

test("缺机型 / 结果未完成 / 时长缺失分别转作废", () => {
  const items = planDraftRetirement(
    [
      baseRecord({ id: "missing-device", deviceModel: null }),
      baseRecord({ id: "not-completed", result: "NOT_COMPLETED" }),
      baseRecord({ id: "missing-duration", durationMinutes: null }),
    ],
    CATEGORIES,
    { withdrawnMode: null },
  );
  assert.equal(items[0].action, "void");
  assert.deepEqual(items[0].voidReasons, ["device-model-missing"]);
  assert.equal(items[1].action, "void");
  assert.deepEqual(items[1].voidReasons, ["result-not-completed"]);
  assert.equal(items[2].action, "void");
  assert.deepEqual(items[2].voidReasons, ["duration-missing-or-invalid"]);
});

test("分类失效按故障类型重映射；电话不合法用报名电话纠正", () => {
  const [item] = planDraftRetirement(
    [
      baseRecord({
        categoryId: "cat-retired",
        ownerPhone: "12345",
        registration: registration({ issueType: "CLEAN_ONLY", phone: "13800003333" }),
      }),
    ],
    CATEGORIES,
    { withdrawnMode: null },
  );
  assert.equal(item.action, "submit");
  assert.equal(item.patch.categoryId, "cat-cool");
  assert.deepEqual(item.categoryRemapped, { from: "cat-retired", toCode: "COOLING_CLEANING" });
  assert.equal(item.patch.ownerPhone, "13800003333");
});

test("已撤回草稿：未指定策略只报告，指定后按策略处置", () => {
  const source = baseRecord({
    id: "record-withdrawn",
    submittedAt: new Date("2026-09-30T08:00:00.000Z"),
  });
  const [pending] = planDraftRetirement([source], CATEGORIES, { withdrawnMode: null });
  assert.equal(pending.action, "withdrawn-pending");
  assert.equal(pending.eligibleToSubmit, true);
  assert.equal(pending.previousSubmittedAt, "2026-09-30T08:00:00.000Z");

  const [voided] = planDraftRetirement([source], CATEGORIES, { withdrawnMode: "void" });
  assert.equal(voided.action, "void");
  assert.ok(voided.voidReasons.includes("withdrawn-policy-void"));

  const [submitted] = planDraftRetirement([source], CATEGORIES, { withdrawnMode: "submit" });
  assert.equal(submitted.action, "submit");
});

test("来源分组与汇总计数稳定", () => {
  const items = planDraftRetirement(
    [
      baseRecord({
        id: "activity",
        ownerPhone: null,
        registration: registration(),
        createRequestKey: "activity-serve:registration-1",
      }),
      baseRecord({
        id: "legacy",
        createRequestKey: "activity-serve:lost-registration",
        deviceModel: null,
      }),
      baseRecord({ id: "manual", result: "NOT_COMPLETED" }),
      baseRecord({
        id: "withdrawn",
        submittedAt: new Date("2026-09-29T00:00:00.000Z"),
      }),
    ],
    CATEGORIES,
    { withdrawnMode: null },
  );
  const report = summarizeDraftRetirement(items, null);
  assert.equal(report.total, 4);
  assert.deepEqual(report.byAction, { submit: 1, void: 2, "withdrawn-pending": 1 });
  assert.deepEqual(report.bySource.activity.submit, 1);
  assert.deepEqual(report.bySource["legacy-activity"].void, 1);
  assert.deepEqual(report.bySource.manual.void, 1);
  assert.equal(report.byMissingField.ownerPhone, 1);
  assert.equal(report.byMissingField.deviceModel, 1);
  assert.equal(report.byBackfilledField.ownerPhone, 1);
  assert.equal(report.byVoidReason["device-model-missing"], 1);
  assert.equal(report.byVoidReason["result-not-completed"], 1);
  assert.deepEqual(report.withdrawn, {
    total: 1,
    eligibleToSubmit: 1,
    ineligible: 0,
    mode: null,
  });
});

test("空列表报告全为零", () => {
  const report = summarizeDraftRetirement([], null);
  assert.equal(report.total, 0);
  assert.deepEqual(report.byAction, { submit: 0, void: 0, "withdrawn-pending": 0 });
  assert.deepEqual(report.byMissingField, {});
  assert.deepEqual(report.byVoidReason, {});
});
