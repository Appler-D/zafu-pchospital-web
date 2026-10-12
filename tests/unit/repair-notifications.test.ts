import assert from "node:assert/strict";
import test from "node:test";

import { toNotificationView } from "../../src/features/community/community-view";
import { assertCanReadRepair } from "../../src/features/repairs/repair-policy";
import { AppError } from "../../src/lib/api/errors";
import { permissionsForRoles } from "../../src/lib/auth/permissions";
import type { AuthorizedActor } from "../../src/types/contracts";

const owner: AuthorizedActor = {
  actorType: "USER",
  userId: "owner",
  userStatus: "ACTIVE",
  permissions: permissionsForRoles(["MEMBER"]),
  requestId: "req_notification",
};
const participant = { ...owner, userId: "participant" };
const reviewer = { ...participant, permissions: permissionsForRoles(["ADMIN"]) };
const row: Parameters<typeof toNotificationView>[0] = {
  id: "notification",
  type: "REPAIR_REJECTED",
  status: "UNREAD",
  repairRecordId: "record",
  commentId: "comment",
  createdAt: new Date(),
  readAt: null,
  actor: null,
  record: {
    content: "历史正文",
    remark: "退回备注",
    status: "REJECTED",
    deletedAt: null,
    memberProfile: { userId: "owner" },
  },
};

test("退回通知不扩大读取权限：保留事件但隐藏不可见记录的引用与摘要", () => {
  for (const status of ["DRAFT", "PENDING", "REJECTED"]) {
    const notification = { ...row, record: { ...row.record!, status } };
    const view = toNotificationView(notification, participant);
    assert.equal(view.type, "REPAIR_REJECTED");
    assert.equal(view.status, "UNREAD");
    assert.equal(view.repairRecordId, null);
    assert.equal(view.commentId, null);
    assert.equal(view.repairExcerpt, null);
    assert.throws(
      () => assertCanReadRepair(participant, notification.record),
      (error) => error instanceof AppError && error.code === "REPAIR_NOT_FOUND",
    );
    for (const actor of [owner, reviewer]) {
      assertCanReadRepair(actor, notification.record);
      assert.equal(toNotificationView(notification, actor).repairRecordId, "record");
      assert.equal(toNotificationView(notification, actor).repairExcerpt, "退回备注");
    }
  }
});

test("已通过记录的通知可跳转；记录软删除、缺失或无读取权限时收口", () => {
  const approved = { ...row, record: { ...row.record!, status: "APPROVED" } };
  assert.equal(toNotificationView(approved, participant).repairRecordId, "record");
  for (const actor of [owner, participant, reviewer]) {
    const deleted = toNotificationView(
      { ...approved, record: { ...approved.record, deletedAt: new Date() } },
      actor,
    );
    assert.equal(deleted.repairRecordId, null);
    assert.equal(deleted.repairExcerpt, null);
    assert.equal(toNotificationView({ ...row, record: null }, actor).repairRecordId, null);
  }
  assert.equal(toNotificationView(approved, { ...owner, permissions: [] }).repairRecordId, null);
});
