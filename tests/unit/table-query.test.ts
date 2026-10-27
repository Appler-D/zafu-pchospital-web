import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { tableField, tableQueryOptions, tableSortLabel } from "../../src/config/table-queries";
import {
  readTableParams,
  shareableTableParams,
  emptyTableQuery,
  tableRequestParams,
} from "../../src/lib/table/query-state";
import { tableQueryInput } from "../../src/features/admin/table-http";
import { parseFilters } from "../../src/lib/api/list-filter";
import { auditTableQuery } from "../../src/lib/table/audit-query";

test("查询状态：仅日期/枚举和受控排序可分享，敏感文本不进入 URL 或审计", () => {
  const options = tableQueryOptions("join-applications");
  const value = {
    ...emptyTableQuery({
      query: "真实姓名 123456",
      status: "INTERVIEW_PASSED",
      recruitmentCycle: "私人文字",
    }),
    sort: [{ field: "approvedAt", direction: "desc" as const }],
    filters: [
      { field: "realName", op: "contains" as const, value: "私人姓名" },
      { field: "approvedAt", op: "gte" as const, value: "2026-10-01" },
    ],
    groupBy: "status",
  };
  const shared = shareableTableParams(value, options);
  assert.equal(shared.has("query"), false);
  assert.equal(shared.has("recruitmentCycle"), false);
  assert.deepEqual(shared.getAll("filter"), ["approvedAt:gte:2026-10-01"]);
  const restored = readTableParams(
    shared,
    { query: "", status: "", recruitmentCycle: "" },
    options,
  );
  assert.deepEqual(restored.sort, value.sort);
  assert.equal(restored.fixed.query, "");
  assert.equal(restored.groupBy, "status");
  const input = tableQueryInput(tableRequestParams(value, 3), "join-applications");
  assert.equal(input.page, 3);
  assert.equal(input.pageSize, 20);
  assert.equal(input.filters.length, 2);
  const audit = JSON.stringify(auditTableQuery({ ...input, query: value.fixed.query }));
  assert.equal(audit.includes("私人姓名"), false);
  assert.equal(audit.includes("真实姓名"), false);
  assert.deepEqual(emptyTableQuery({ query: "", status: "" }), {
    fixed: { query: "", status: "" },
    sort: [],
    filters: [],
    groupBy: "",
  });
});

test("查询白名单：非法字段、方向、分组和原型键受控拒绝", () => {
  for (const query of [
    "sort=passwordHash:asc",
    "sort=createdAt:sql",
    "groupBy=actorUserId",
    "filter=__proto__:eq:x",
    "filter=action:gte:x",
  ]) {
    assert.throws(() => tableQueryInput(new URLSearchParams(query), "audit"), {
      code: "VALIDATION_FAILED",
    });
  }
  assert.throws(() => parseFilters(["constructor:eq:x"], { status: ["eq"] }), {
    code: "VALIDATION_FAILED",
  });
});

test("复合成员列明确区分创建人排序与任一参与人筛选", async () => {
  assert.equal(tableSortLabel("repairs", "memberName"), "创建成员实名");
  assert.equal(tableField("repairs", "memberName").label, "参与成员姓名");
  (globalThis as unknown as { React: typeof React }).React = React;
  const { AdminTableQuery } = await import("../../src/components/admin/AdminTableQuery");
  const html = renderToStaticMarkup(
    React.createElement(AdminTableQuery, {
      value: {
        ...emptyTableQuery({ query: "" }),
        sort: [{ field: "memberName", direction: "asc" }],
        filters: [{ field: "memberName", op: "contains", value: "参与者" }],
      },
      options: tableQueryOptions("repairs"),
      quick: [],
      refreshing: false,
      onChange() {},
      onClear() {},
    }),
  );
  assert.match(html, /创建成员实名/);
  assert.match(html, /参与成员姓名/);
});

test("共用查询界面：清除和高级入口常驻，排序/条件可独立移除，不含成功结论", async () => {
  (globalThis as unknown as { React: typeof React }).React = React;
  const { AdminTableQuery } = await import("../../src/components/admin/AdminTableQuery");
  const html = renderToStaticMarkup(
    React.createElement(AdminTableQuery, {
      value: {
        ...emptyTableQuery({ query: "" }),
        sort: [{ field: "approvedAt", direction: "desc" }],
        filters: [{ field: "status", op: "eq", value: "INTERVIEW_PASSED" }],
      },
      options: tableQueryOptions("join-applications"),
      quick: [{ key: "query", label: "关键词" }],
      ready: false,
      refreshing: false,
      onChange() {},
      onClear() {},
    }),
  );
  assert.match(html, /method="post"/);
  assert.match(html, /<fieldset[^>]*disabled/);
  assert.match(html, /重置/);
  assert.match(html, /高级筛选与统计/);
  assert.match(html, /通过时间/);
  assert.match(html, /面试通过/);
  assert.doesNotMatch(html, /链接保留排序|仅保留在当前页面/);
});
