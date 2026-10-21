import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { adminCopy, adminNav } from "../../src/config/admin";
import type { RepairDetailView } from "../../src/types/contracts";

test("#198 成员 / 管理详情移除评论，仍显示收藏、标记、备注、照片和审核操作", async (t) => {
  (globalThis as unknown as { React: typeof React }).React = React;
  const hooks = createRequire(import.meta.url)("react") as typeof React;
  const record = {
    id: "record",
    version: 1,
    status: "APPROVED",
    result: "COMPLETED",
    member: { id: "member", name: "维修成员" },
    participants: [{ id: "member", name: "维修成员" }],
    category: null,
    repairDate: "2026-10-20",
    durationMinutes: 30,
    ownerName: "机主",
    ownerPhone: null,
    deviceModel: null,
    content: null,
    remark: "保留的维修备注",
    isDifficult: true,
    isTypical: true,
    isFavorited: false,
    canEdit: false,
    canFlag: false,
    canReview: false,
    photos: [],
    reviews: [],
    timeline: [],
  } as unknown as RepairDetailView;
  let memberRender = true,
    slot = 0;
  t.mock.method(hooks, "useState", <S>(initial: S | (() => S)) => {
    const index = slot++;
    const value =
      memberRender && index === 0
        ? record
        : memberRender && index === 1
          ? "ready"
          : typeof initial === "function"
            ? (initial as () => S)()
            : initial;
    return [value, () => {}];
  });
  t.mock.method(hooks, "useEffect", () => {});
  t.mock.method(hooks, "useRef", <T>(initial: T) => ({ current: initial }));
  const { RepairDetail } = await import("../../src/components/repairs/RepairDetail");
  const member = renderToStaticMarkup(
    React.createElement(RepairDetail, {
      recordId: record.id,
      statusLabels: { APPROVED: "已通过" },
      resultLabels: { COMPLETED: "已完成" },
      timelineLabels: {},
    }),
  );
  assert.doesNotMatch(member, /交流讨论|发表评论|community-thread|community-composer/);
  for (const text of [
    "收藏",
    "疑难案例",
    "典型案例",
    "保留的维修备注",
    "维修照片",
    "审核信息",
    "记录时间线",
  ])
    assert.ok(member.includes(text), text);

  memberRender = false;
  const { RepairAdminActions } = await import("../../src/components/admin/RepairAdminActions");
  // 直接检查真实详情内容；共享 Portal 外壳的挂载 / 滚动锁不在本轮变更范围。
  const panel = RepairAdminActions({ record, categories: [], onClose() {}, onChanged() {} });
  const admin = renderToStaticMarkup(React.createElement("section", null, panel.props.children));
  assert.doesNotMatch(admin, /评论|admin-comments/);
  for (const text of [
    adminCopy.repairs.action.approve,
    adminCopy.repairs.action.reject,
    "照片",
    "备注",
  ])
    assert.ok(admin.includes(text), text);
  assert.equal(
    adminNav.some((item) => item.href === "/admin/comments"),
    false,
  );
  assert.equal("/admin/comments" in adminCopy.home.directoryDesc, false);
});
