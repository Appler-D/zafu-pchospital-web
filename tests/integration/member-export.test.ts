import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import ExcelJS from "exceljs";
import { GET as exportRoute } from "../../src/app/api/v1/admin/members/export/route";
import { memberExportService } from "../../src/features/admin/member-export-service";
import { memberListInput } from "../../src/features/members/member-http";
import { memberRepository } from "../../src/features/members/member-repository";
import { memberService } from "../../src/features/members/member-service";
import { disconnectDb, getDb } from "../../src/lib/db/client";
import { EXPORT_MAX_ROWS } from "../../src/types/contracts";
import {
  tableFixtureId as id,
  tableFixtureActor as actor,
  cleanupTableQueryFixtures,
  prepareTableQueryFixtures,
} from "../fixtures/table-query";
import { integrationTestsEnabled } from "./db-guard";
import { sessionCookie } from "./http-harness";

const enabled = integrationTestsEnabled();
const dbTest = enabled ? test : test.skip;
let cookie = "";
let memberCookie = "";
const query = { query: "I214 联调" };

before(async () => {
  if (!enabled) return;
  ({ cookie } = await prepareTableQueryFixtures());
  memberCookie = await sessionCookie(id(2), "MEMBER");
  const db = getDb();
  await db.memberProfile.update({
    where: { id: id(2) },
    data: { studentId: "00123456", nickname: "=1+1", sortOrder: 2 },
  });
  await db.memberProfile.update({ where: { id: id(3) }, data: { sortOrder: 1 } });
  for (const [n, type, value] of [
    [60, "QQ", "998232001"],
    [61, "PHONE", "13982320001"],
    [62, "EMAIL", "i232-private@example.invalid"],
  ] as const)
    await db.userIdentity.create({
      data: {
        id: id(n),
        userId: id(2),
        type,
        identifierNormalized: value,
        verifiedAt: new Date(),
        createdAt: new Date(),
        activeEmailKey: type === "EMAIL" ? `email:${id(2)}` : null,
      },
    });
  for (const n of [20, 21])
    await db.repairRecordParticipant.create({
      data: {
        id: id(n + 200),
        repairRecordId: id(n),
        memberProfileId: id(2),
        sortOrder: 0,
        createdAt: new Date(),
      },
    });
});
after(async () => {
  if (!enabled) return;
  await cleanupTableQueryFixtures();
  await disconnectDb();
});

function request(params: URLSearchParams, auth = cookie) {
  return new Request(`http://localhost/api/v1/admin/members/export?${params}`, {
    headers: { cookie: auth, "X-Request-Id": "req_i232_export" },
  });
}

dbTest("成员导出覆盖未加载页并与列表同序，CSV 脱敏、防公式，Excel 保留前导零与统计", async () => {
  const input = {
    ...query,
    sort: [{ field: "realName", direction: "asc" as const }],
  };
  const page1 = await memberService.list({ ...input, page: 1, pageSize: 1 }, actor);
  const page2 = await memberService.list({ ...input, page: 2, pageSize: 1 }, actor);
  assert.equal(page1.pagination.total, 2);
  const csv = await memberExportService.export(input, "CSV", actor);
  assert.equal(csv.rowCount, 2);
  assert.deepEqual([...csv.body.slice(0, 3)], [239, 187, 191]);
  const text = new TextDecoder().decode(csv.body);
  assert.ok(text.indexOf(page1.items[0].id) < text.indexOf(page2.items[0].id));
  assert.ok(text.includes("'=1+1"));
  assert.ok(text.includes("00123456"));
  assert.ok(text.includes(page1.items[0].qqMasked!));
  assert.ok(text.includes(page1.items[0].phoneMasked!));
  for (const secret of ["998232001", "13982320001", "example.invalid", "邮箱", "userId"])
    assert.equal(text.includes(secret), false, secret);
  const workbook = new ExcelJS.Workbook();
  const xlsx = await memberExportService.export(input, "XLSX", actor);
  await workbook.xlsx.load(xlsx.body.buffer);
  const sheet = workbook.worksheets[0];
  assert.equal(sheet.rowCount, 3);
  assert.equal(sheet.getCell("B2").value, "=1+1");
  assert.equal(sheet.getCell("E2").value, "00123456");
  assert.equal(sheet.getCell("E2").numFmt, "@");
  assert.equal(sheet.getCell("J2").value, "2");
  assert.equal(sheet.getCell("K2").value, "41");
  assert.equal(sheet.getCell("N2").value, page1.items[0].id);
  assert.equal(sheet.getCell("N3").value, page2.items[0].id);
  // 清除显式排序后，导出恢复持久化拖动顺序。
  const defaultCsv = await memberExportService.export(query, "CSV", actor);
  const defaultText = new TextDecoder().decode(defaultCsv.body);
  assert.ok(defaultText.indexOf(id(3)) < defaultText.indexOf(id(2)));
});

dbTest("成员导出 HTTP 共用组合条件、忽略分页/分组，响应附件头与审计保持一致", async () => {
  const params = new URLSearchParams({
    query: query.query,
    status: "ACTIVE",
    role: "MEMBER",
    sort: "joinedAt:desc,realName:asc",
    page: "99",
    pageSize: "1",
    groupBy: "department",
    format: "csv",
  });
  params.append("filter", "department:eq:REPAIR");
  params.append("filter", "nickname:contains:=1+1");
  params.append("filter", "joinedAt:gte:2026-10-24");
  params.append("filter", "joinedAt:lte:2026-10-24");
  const list = await memberService.list(memberListInput(params, 1, 1), actor);
  assert.equal(list.pagination.total, 1);
  const response = await exportRoute(request(params));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Export-Row-Count"), "1");
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.match(response.headers.get("Content-Type")!, /text\/csv/);
  assert.match(response.headers.get("Content-Disposition")!, /attachment; filename="members-/);
  const body = await response.text();
  assert.ok(body.includes(list.items[0].id));
  assert.equal(body.includes(id(3)), false);
  const audit = await getDb().auditLog.findFirstOrThrow({
    where: { action: "member.exported", requestId: "req_i232_export" },
    orderBy: { createdAt: "desc" },
  });
  assert.equal(audit.targetType, "MemberExport");
  assert.equal(audit.result, "SUCCESS");
  const summary = audit.afterSummary as { rowCount: number; filter: Record<string, unknown> };
  assert.equal(summary.rowCount, 1);
  assert.equal(JSON.stringify(summary).includes(query.query), false);
  assert.equal(JSON.stringify(summary).includes("=1+1"), false);
  assert.equal("page" in summary.filter, false);
  assert.equal("groupBy" in summary.filter, false);
});

dbTest("成员导出空结果返回零计数；非法格式、排序、筛选拒绝返回文件", async () => {
  const response = await exportRoute(request(new URLSearchParams({ query: "I232 无匹配成员" })));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Export-Row-Count"), "0");
  assert.equal((await response.text()).trim().split("\r\n").length, 1);
  for (const [params, code] of [
    ["format=pdf", "EXPORT_FORMAT_INVALID"],
    ["sort=email:asc", "VALIDATION_FAILED"],
    ["filter=phone:contains:123", "VALIDATION_FAILED"],
    ["filter=department:eq:INVALID", "VALIDATION_FAILED"],
  ]) {
    const invalid = await exportRoute(request(new URLSearchParams(params)));
    assert.equal(invalid.status, 400, params);
    assert.equal((await invalid.json()).error.code, code);
    assert.equal(invalid.headers.has("Content-Disposition"), false);
  }
});

dbTest("成员导出必须同时具备管理与导出权限，匿名/普通成员无法下载", async () => {
  for (const permission of ["member:manage", "data:export"] as const)
    await assert.rejects(
      () =>
        memberExportService.export(query, "CSV", {
          ...actor,
          permissions: actor.permissions.filter((item) => item !== permission),
        }),
      { code: "FORBIDDEN" },
    );
  assert.equal((await exportRoute(request(new URLSearchParams(), ""))).status, 401);
  const forbidden = await exportRoute(request(new URLSearchParams(), memberCookie));
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.headers.has("Content-Disposition"), false);
});

dbTest("成员导出超限拒绝而不截断，不写成功审计；审计失败也不返回附件", async (t) => {
  const db = getDb();
  const auditCount = () =>
    db.auditLog.count({ where: { action: "member.exported", actorUserId: actor.userId } });
  const before = await auditCount();
  // Prisma delegate 是虚拟 Proxy，不能用 mock.method 替换；仅替换客户端缓存，避免造两万条夹具。
  const runtime = globalThis as typeof globalThis & { __pcHospitalDb?: typeof db };
  const previous = runtime.__pcHospitalDb;
  try {
    runtime.__pcHospitalDb = {
      memberProfile: {
        findMany: async (args: { take: number }) => {
          assert.equal(args.take, EXPORT_MAX_ROWS + 1);
          return Array.from({ length: EXPORT_MAX_ROWS + 1 }, () => ({}));
        },
      },
    } as unknown as typeof db;
    await assert.rejects(() => memberExportService.export(query, "CSV", actor), {
      code: "EXPORT_ROW_LIMIT_EXCEEDED",
      status: 409,
    });
  } finally {
    runtime.__pcHospitalDb = previous;
  }
  assert.equal(await auditCount(), before);
  t.mock.method(memberRepository, "exportRows", async () => []);
  try {
    runtime.__pcHospitalDb = {
      $transaction: async () => {
        throw new Error("audit unavailable");
      },
    } as unknown as typeof db;
    await assert.rejects(
      () => memberExportService.export(query, "CSV", actor),
      /audit unavailable/,
    );
  } finally {
    runtime.__pcHospitalDb = previous;
  }
});
