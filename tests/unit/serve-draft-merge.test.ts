import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeServePrefill,
  type CreateDraftSnapshot,
} from "../../src/components/repairs/create-draft-storage";

const prefill = {
  name: "顾客甲",
  phone: "13900000001",
  deviceModel: "联想小新 Air 14",
  categoryId: "category-system",
  repairDate: "2026-10-24",
};

test("接待补单无本机暂存：使用登记行预填，时长与备注留空", () => {
  assert.deepEqual(mergeServePrefill(null, prefill), {
    repairDate: "2026-10-24",
    durationMinutes: null,
    categoryId: "category-system",
    ownerName: "顾客甲",
    ownerPhone: "13900000001",
    deviceModel: "联想小新 Air 14",
    remark: null,
    participantIds: [],
  });
});

test("接待补单有本机暂存：整体采用，显式清空的字段不被预填覆盖（#221 审查）", () => {
  const stored: CreateDraftSnapshot = {
    repairDate: "2026-10-23",
    durationMinutes: 15,
    categoryId: null,
    ownerName: "顾客甲",
    ownerPhone: "13900000001",
    deviceModel: null,
    remark: "已清空分类与机型",
    participantIds: [],
  };
  const merged = mergeServePrefill(stored, prefill);
  assert.equal(merged.categoryId, null, "清空的分类不能被预填重新填上");
  assert.equal(merged.deviceModel, null);
  assert.equal(merged.durationMinutes, 15);
  assert.equal(merged.repairDate, "2026-10-23");
  assert.equal(merged.remark, "已清空分类与机型");
});
