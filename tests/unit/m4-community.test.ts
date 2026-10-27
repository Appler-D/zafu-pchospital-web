import assert from "node:assert/strict";
import test from "node:test";

import { ApiErrorCode, AppError } from "../../src/lib/api/errors";
import {
  createFavoriteInput,
  notificationStatusFilter,
} from "../../src/features/community/community-http";
import { excerptText, memberRef } from "../../src/features/community/community-view";
import {
  settleCommunity,
  toFavoriteSummary,
  toNotificationSummary,
} from "../../src/features/member-dashboard/community-summary";
import {
  MEMBER_DASHBOARD_FAVORITE_LIMIT,
  MEMBER_DASHBOARD_NOTIFICATION_LIMIT,
  NotificationStatus,
  NotificationType,
  Permission,
} from "../../src/types/contracts";
import { communityCopy } from "../../src/config/community";
import { memberCopy } from "../../src/config/member";

/**
 * M4 契约与纯逻辑测试（不依赖数据库 / HTTP）。
 *
 * 收藏 / 审核通知的错误码、限额与文案边界在这里锁死；
 * 历史通知过滤、通知已读、收藏恢复与越权在 `tests/integration/m4-community.test.ts`。
 */

test("M4 稳定错误码已进入公共契约且状态码正确", () => {
  for (const code of ["FAVORITE_NOT_FOUND", "NOTIFICATION_NOT_FOUND"] as const) {
    assert.equal(ApiErrorCode.includes(code), true, `错误码 ${code} 未包含在 ApiErrorCode 中`);
  }
  const statusOf = (code: (typeof ApiErrorCode)[number]) => new AppError(code, "test").status;
  assert.equal(statusOf("FAVORITE_NOT_FOUND"), 404);
  assert.equal(statusOf("NOTIFICATION_NOT_FOUND"), 404);
});

test("M4 权限与限额常量已冻结", () => {
  for (const permission of ["favorite:manage", "notification:read"] as const) {
    assert.equal(Permission.includes(permission), true, `权限 ${permission} 未定义`);
  }
  assert.equal(MEMBER_DASHBOARD_NOTIFICATION_LIMIT, 5);
  assert.equal(MEMBER_DASHBOARD_FAVORITE_LIMIT, 5);
  assert.deepEqual(NotificationType, ["REPAIR_APPROVED", "REPAIR_REJECTED"]);
  assert.deepEqual(NotificationStatus, ["UNREAD", "READ"]);
});

test("收藏请求拒绝未知字段，通知状态仍使用统一解析", () => {
  assert.throws(
    () => createFavoriteInput({ repairRecordId: "r1", extra: true }),
    (error) => error instanceof AppError && error.code === "VALIDATION_FAILED",
  );
  assert.deepEqual(createFavoriteInput({ repairRecordId: " r1 " }), { repairRecordId: "r1" });
  assert.equal(notificationStatusFilter(new URLSearchParams("status=UNREAD")), "UNREAD");
  assert.throws(
    () => notificationStatusFilter(new URLSearchParams("status=DONE")),
    (error) => error instanceof AppError && error.code === "VALIDATION_FAILED",
  );
});

test("成员展示名与摘要截断按昵称/实名/账号名回退", () => {
  assert.deepEqual(
    memberRef({ id: "m1", nickname: "小林", realName: "林晓", user: { displayName: "账号" } }),
    { id: "m1", name: "小林" },
  );
  assert.equal(memberRef({ id: "m2", nickname: null, realName: "林晓" }).name, "林晓");
  // 摘要取值链：备注优先，老记录的维修内容回退，双空占位「未填写备注」。
  assert.equal(excerptText({ remark: "备注内容", content: "老正文" }), "备注内容");
  assert.equal(excerptText({ remark: "  ", content: "老正文" }), "老正文");
  assert.equal(excerptText({ remark: null, content: null }), "未填写备注");
  assert.equal(excerptText({ remark: "短内容", content: null }), "短内容");
  assert.equal(excerptText({ remark: "字".repeat(61), content: null }).endsWith("…"), true);
  assert.equal([...excerptText({ remark: "字".repeat(61), content: null })].length, 61);
});

test("M5 接入后文案不再声称排行未接入，且不出现内部里程碑编号", () => {
  const text = JSON.stringify({ communityCopy, memberCopy });
  // M5 已把维修排行做成真实数据：「后续模块开放」「尚未接入」这类承诺必须消失，
  // 否则页面会对外宣称一个并不存在的限制。
  assert.doesNotMatch(text, /后续模块开放|尚未接入/);
  // 内部里程碑编号（M4/M5）不得出现在任何用户可见文案里。
  assert.doesNotMatch(text, /M\d/);
  assert.doesNotMatch(text, /红点|角标|模拟数据/);
  // 排行区块的标题与状态文案仍然存在，避免把区块删空
  assert.match(memberCopy.dashboard.rankingTitle, /排行/);
  assert.match(memberCopy.dashboard.rankingEmpty, /本学年/);
});

/**
 * 回归：通知/收藏摘要**失败时不得把计数降级成 0**。
 *
 * 早先的实现失败时返回 `{ available: true, unreadCount: 0 }`，
 * 于是接口层面分不出「查询失败」和「真的没有未读」——调用方会把一次数据库故障
 * 渲染成「你没有新消息」，静默丢消息。现在与 M3 的 `MetricValue` 口径对齐：
 * `available: false` + 计数 `null`。
 */
test("通知/收藏摘要失败时 available 为 false 且计数为 null，不给 0", async () => {
  const failure = () => Promise.reject(new AppError("INTERNAL_ERROR", "库挂了"));

  const notifications = toNotificationSummary(await settleCommunity(failure()));
  const favorites = toFavoriteSummary(await settleCommunity(failure()));

  assert.equal(notifications.available, false);
  assert.equal(notifications.unreadCount, null);
  assert.notEqual(notifications.unreadCount, 0);
  assert.deepEqual(notifications.latest, []);

  assert.equal(favorites.available, false);
  assert.equal(favorites.count, null);
  assert.notEqual(favorites.count, 0);
  assert.deepEqual(favorites.latest, []);
});

test("通知/收藏摘要成功时保留真实计数，0 只可能来自查询结果本身", async () => {
  const notifications = toNotificationSummary(
    await settleCommunity(Promise.resolve({ unreadCount: 0, latest: [] })),
  );
  const favorites = toFavoriteSummary(
    await settleCommunity(Promise.resolve({ count: 3, latest: [] })),
  );

  // 「0 条未读」是真实结论 —— 与上面的 null 必须是两个不同的值
  assert.equal(notifications.available, true);
  assert.equal(notifications.unreadCount, 0);

  assert.equal(favorites.available, true);
  assert.equal(favorites.count, 3);
});

test("settleCommunity 保留错误码，取不到 code 时退回既定兜底码", async () => {
  const withCode = await settleCommunity(Promise.reject(new AppError("INTERNAL_ERROR", "库挂了")));
  const withoutCode = await settleCommunity(Promise.reject(new Error("普通异常")));

  assert.deepEqual(withCode, { status: "failed", code: "INTERNAL_ERROR" });
  assert.deepEqual(withoutCode, { status: "failed", code: "OVERVIEW_SECTION_FAILED" });
});
