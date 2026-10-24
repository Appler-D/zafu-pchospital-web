import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { GET as joinListRoute } from "../../src/app/api/v1/admin/join-applications/route";
import { joinApplicationService } from "../../src/features/recruitment/join-application-service";
import { joinApplicationExportService } from "../../src/features/admin/join-application-export-service";
import { repairExportService } from "../../src/features/admin/repair-export-service";
import { repairQueryService } from "../../src/features/repairs/repair-query-service";
import { memberService } from "../../src/features/members/member-service";
import { inviteCodeService } from "../../src/features/invitations/invite-code-service";
import { auditLogService } from "../../src/features/admin/audit-log-service";
import { disconnectDb } from "../../src/lib/db/client";
import { tableQueryInput } from "../../src/features/admin/table-http";
import {
  tableFixtureId as id,
  tableFixtureActor as actor,
  cleanupTableQueryFixtures,
  prepareTableQueryFixtures,
} from "../fixtures/table-query";
import { integrationTestsEnabled } from "./db-guard";

const enabled = integrationTestsEnabled();
const dbTest = enabled ? test : test.skip;
let cookie = "";
before(async () => {
  if (enabled) ({ cookie } = await prepareTableQueryFixtures());
});
after(async () => {
  if (enabled) {
    await cleanupTableQueryFixtures();
    await disconnectDb();
  }
});

dbTest(
  "报名闭环：首次通过时间独立于面试/补记，分页稳定、分组全量、导出同序且 HTTP 不多披露",
  async () => {
    await assert.rejects(
      () =>
        joinApplicationService.list(
          { page: 1, pageSize: 20, recruitmentCycle: "X".repeat(33) },
          actor,
        ),
      { code: "VALIDATION_FAILED" },
    );
    const input = {
      ...tableQueryInput(
        new URLSearchParams("sort=approvedAt:desc&groupBy=status"),
        "join-applications",
      ),
      recruitmentCycle: "I214-本地联调",
      pageSize: 1,
    };
    const first = await joinApplicationService.list(input, actor);
    const second = await joinApplicationService.list({ ...input, page: 2 }, actor);
    assert.equal(first.items[0].id, id(11));
    assert.equal(second.items[0].id, id(10));
    assert.equal(second.items[0].approvedAt, "2026-10-24T01:00:00.000Z");
    assert.notEqual(second.items[0].lastReviewedAt, second.items[0].approvedAt);
    assert.equal(first.pagination.total, 4);
    assert.equal(
      first.summary?.counts.reduce((n, row) => n + row.count, 0),
      4,
    );
    const legacy = await joinApplicationService.list({ ...input, pageSize: 20 }, actor);
    assert.equal(legacy.items.find((row) => row.id === id(13))?.approvedAt, null);
    const filtered = {
      ...input,
      filters: [{ field: "approvedAt", op: "gte" as const, value: "2026-10-24" }],
    };
    assert.equal((await joinApplicationService.list(filtered, actor)).pagination.total, 2);
    const exported = await joinApplicationExportService.export(filtered, "CSV", actor);
    const csv = new TextDecoder().decode(exported.body);
    assert.ok(csv.indexOf("I214-11") < csv.indexOf("I214-10"));
    assert.equal(exported.rowCount, 2);
    const response = await joinListRoute(
      new Request(
        "http://localhost/api/v1/admin/join-applications?recruitmentCycle=I214-%E6%9C%AC%E5%9C%B0%E8%81%94%E8%B0%83&sort=approvedAt:desc&groupBy=status",
        { headers: { cookie } },
      ),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    const json = await response.json();
    assert.equal(json.data[0].approvedAt, first.items[0].approvedAt);
    for (const row of json.data) {
      assert.equal("email" in row, false);
      assert.equal("qq" in row, false);
      assert.equal("phone" in row, false);
    }
    assert.equal(
      json.meta.summary.counts.reduce((n: number, row: { count: number }) => n + row.count, 0),
      json.meta.pagination.total,
    );
  },
);

dbTest("维修/成员：筛选、计数与全量分组一致，维修导出同排序，保留默认隐藏草稿", async () => {
  const filters = [
    { field: "deviceModel", op: "contains" as const, value: "I214" },
    { field: "durationMinutes", op: "gte" as const, value: "20" },
  ];
  const input = {
    page: 1,
    pageSize: 1,
    filters,
    groupBy: "status",
    sort: [{ field: "durationMinutes", direction: "desc" as const }],
  };
  const repairs = await repairQueryService.list(input, actor);
  assert.equal(repairs.pagination.total, 2);
  assert.equal(repairs.items[0].id, id(21));
  assert.equal(repairs.summary?.counts[0].count, 2);
  const csv = await repairExportService.export(input, "CSV", actor);
  assert.equal(csv.rowCount, 2);
  assert.ok(
    new TextDecoder().decode(csv.body).indexOf(id(21)) <
      new TextDecoder().decode(csv.body).indexOf(id(20)),
  );
  const draft = await repairQueryService.list(
    { ...input, filters: [...filters, { field: "status", op: "eq", value: "DRAFT" }] },
    actor,
  );
  assert.equal(draft.items[0].id, id(22));
  const members = await memberService.list(
    {
      page: 1,
      pageSize: 1,
      query: "I214 联调",
      groupBy: "department",
      sort: [{ field: "department", direction: "asc" }],
    },
    actor,
  );
  assert.equal(members.pagination.total, 2);
  assert.equal(
    members.summary?.counts.reduce((n, row) => n + row.count, 0),
    2,
  );
});

dbTest(
  "邀请码/审计：派生状态分组与 SQL 条件一致，排序筛选受控，普通成员不得借分组越权",
  async () => {
    const invites = await inviteCodeService.list(
      {
        page: 1,
        pageSize: 1,
        query: "I214-",
        groupBy: "status",
        sort: [{ field: "usedCount", direction: "desc" }],
        filters: [{ field: "maxUses", op: "gte", value: "10" }],
      },
      actor,
    );
    assert.equal(invites.pagination.total, 3);
    assert.equal(invites.items[0].usedCount, 2);
    assert.deepEqual(
      invites.summary?.counts
        .filter((row) => row.count)
        .map((row) => row.value)
        .sort(),
      ["ACTIVE", "EXPIRED", "REVOKED"],
    );
    const activeSubset = await inviteCodeService.list(
      {
        page: 1,
        pageSize: 20,
        query: "I214-",
        groupBy: "status",
        filters: [{ field: "status", op: "neq", value: "REVOKED" }],
      },
      actor,
    );
    assert.equal(activeSubset.pagination.total, 2);
    assert.equal(
      activeSubset.summary?.counts.reduce((n, row) => n + row.count, 0),
      2,
    );
    const audit = await auditLogService.list(
      {
        page: 1,
        pageSize: 1,
        action: "I214.query",
        groupBy: "result",
        sort: [{ field: "result", direction: "asc" }],
        filters: [{ field: "targetType", op: "contains", value: "I214" }],
      },
      actor,
    );
    assert.equal(audit.pagination.total, 2);
    assert.equal(audit.summary?.counts.length, 2);
    assert.equal(audit.items[0].result, "FAILURE");
    await assert.rejects(
      () =>
        auditLogService.list(
          { page: 1, pageSize: 20, groupBy: "result" },
          { ...actor, permissions: ["repair:read"] },
        ),
      { code: "FORBIDDEN" },
    );
    await assert.rejects(
      () =>
        repairQueryService.list(
          { page: 1, pageSize: 20, groupBy: "status" },
          { ...actor, permissions: ["repair:read"] },
        ),
      { code: "FORBIDDEN" },
    );
    await assert.rejects(
      () =>
        inviteCodeService.list(
          { page: 1, pageSize: 20, filters: [{ field: "maxUses", op: "gte", value: "1 OR 1=1" }] },
          actor,
        ),
      { code: "VALIDATION_FAILED" },
    );
  },
);
