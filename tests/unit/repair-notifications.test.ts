import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "../../src/generated/prisma/client";
import { createReviewNotification } from "../../src/features/community/notification-service";

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

test("迁移后的审核通知：参与者去重、跳过审核人、兼容无成员档案管理员", async () => {
  const batches: Prisma.NotificationCreateManyInput[][] = [];
  const tx = {
    notification: {
      async createMany({ data }: { data: Prisma.NotificationCreateManyInput[] }) {
        batches.push(data);
      },
    },
  } as unknown as Prisma.TransactionClient;
  const now = new Date("2026-10-21T00:00:00Z");
  const input = {
    recordId: "record",
    recipientMemberProfileIds: ["owner", "owner", "reviewer"],
    now,
  };
  await createReviewNotification(tx, {
    ...input,
    decision: "APPROVED",
    actorMemberProfileId: "reviewer",
  });
  assert.deepEqual(
    batches[0].map((item) => item.recipientMemberProfileId),
    ["owner"],
  );
  assert.equal(batches[0][0].type, "REPAIR_APPROVED");
  assert.equal(batches[0][0].createdAt, now);
  await createReviewNotification(tx, {
    ...input,
    decision: "REJECTED",
    actorMemberProfileId: null,
  });
  assert.deepEqual(
    batches[1].map((item) => item.recipientMemberProfileId),
    ["owner", "reviewer"],
  );
  assert.ok(
    batches[1].every(
      (item) => item.type === "REPAIR_REJECTED" && item.actorMemberProfileId === null,
    ),
  );
  await createReviewNotification(tx, {
    ...input,
    recipientMemberProfileIds: ["reviewer"],
    decision: "APPROVED",
    actorMemberProfileId: "reviewer",
  });
  assert.equal(batches.length, 2);
});

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
      assert.equal(toNotificationView(notification, actor).commentId, null);
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
