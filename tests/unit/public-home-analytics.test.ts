import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { HomePublicAnalytics } from "../../src/components/home/HomePublicAnalytics";
import {
  publicHomeService,
  publicRankingName,
} from "../../src/features/analytics/public-home-service";
import { resetAcademicTermConfigForTests } from "../../src/lib/academic-term";
import type { PrismaClient } from "../../src/generated/prisma/client";
import type { PublicHomeAnalytics } from "../../src/types/contracts";

(globalThis as unknown as { React: typeof React }).React = React;

/** 只替换数据库边界；测试执行真正的策略、聚合查询构造与公开 DTO 投影，不连接任何库。 */
function fixture(t: TestContext) {
  const globals = globalThis as typeof globalThis & { __pcHospitalDb?: PrismaClient };
  const previousDb = globals.__pcHospitalDb;
  const previousStart = process.env.ACADEMIC_TERM_START;
  const previousEnd = process.env.ACADEMIC_TERM_END;
  delete process.env.ACADEMIC_TERM_START;
  delete process.env.ACADEMIC_TERM_END;
  resetAcademicTermConfigForTests();
  const policy = {
    publicRepairStatsEnabled: true,
    publicRepairStatsDetailEnabled: true,
    publicRankingsEnabled: true,
    rankingDisplayName: "NICKNAME",
  };
  const counts: unknown[] = [];
  let aggregates = 0;
  let rankingQueries = 0;
  let memberQueries = 0;
  const db = {
    publicContentSetting: { findUnique: async () => policy as typeof policy | null },
    repairRecord: {
      count: async (input: { where: { repairDate?: unknown } }) => {
        counts.push(input);
        return input.where.repairDate ? 2 : 7;
      },
      aggregate: async () => {
        aggregates += 1;
        return { _sum: { durationMinutes: 90 } };
      },
    },
    $queryRaw: async () => {
      rankingQueries += 1;
      return [{ memberProfileId: "private-member-id", rankingPosition: 1n, approvedCount: 2n }];
    },
    memberProfile: {
      findMany: async () => {
        memberQueries += 1;
        return [
          {
            id: "private-member-id",
            nickname: null,
            realName: "私人实名",
            user: { displayName: "登录账号" },
          },
        ];
      },
    },
  };
  globals.__pcHospitalDb = db as unknown as PrismaClient;
  t.after(() => {
    globals.__pcHospitalDb = previousDb;
    if (previousStart === undefined) delete process.env.ACADEMIC_TERM_START;
    else process.env.ACADEMIC_TERM_START = previousStart;
    if (previousEnd === undefined) delete process.env.ACADEMIC_TERM_END;
    else process.env.ACADEMIC_TERM_END = previousEnd;
    resetAcademicTermConfigForTests();
  });
  return {
    policy,
    db,
    counts,
    queries: () => ({ aggregates, rankingQueries, memberQueries }),
    configureTerm() {
      process.env.ACADEMIC_TERM_START = "2026-09-01";
      process.env.ACADEMIC_TERM_END = "2027-01-31";
      resetAcademicTermConfigForTests();
    },
  };
}

test("公开策略缺行、读取失败或全关：没有任何数据查询或公开输出", async (t) => {
  const f = fixture(t);
  f.policy.publicRepairStatsEnabled = false;
  f.policy.publicRankingsEnabled = false;
  assert.deepEqual(await publicHomeService.get(), { repairStats: null, rankings: null });
  f.db.publicContentSetting.findUnique = async () => null;
  assert.deepEqual(await publicHomeService.get(), { repairStats: null, rankings: null });
  f.db.publicContentSetting.findUnique = async () => {
    throw new Error("database unavailable");
  };
  assert.deepEqual(await publicHomeService.get(), { repairStats: null, rankings: null });
  assert.equal(f.counts.length, 0);
  assert.deepEqual(f.queries(), { aggregates: 0, rankingQueries: 0, memberQueries: 0 });
});

test("辅助开关关闭：只查询并输出总量；后续请求重新读取开关", async (t) => {
  const f = fixture(t);
  f.policy.publicRepairStatsDetailEnabled = false;
  f.policy.publicRankingsEnabled = false;
  assert.deepEqual(await publicHomeService.get(), {
    repairStats: { totalApprovedCount: 7 },
    rankings: null,
  });
  assert.deepEqual(f.counts, [{ where: { status: "APPROVED", deletedAt: null } }]);
  assert.equal(f.queries().aggregates, 0);
  f.policy.publicRepairStatsEnabled = false;
  assert.deepEqual(await publicHomeService.get(), { repairStats: null, rankings: null });
  assert.equal(f.counts.length, 1);
});

test("未配置学期：总量与时长有效，学期指标待配置，不执行无范围排行查询", async (t) => {
  const f = fixture(t);
  const result = await publicHomeService.get();
  assert.deepEqual(result, {
    repairStats: {
      totalApprovedCount: 7,
      details: {
        termApprovedCount: { value: null, status: "UNCONFIGURED" },
        totalApprovedDurationMinutes: 90,
      },
    },
    rankings: { status: "UNCONFIGURED", items: [] },
  });
  assert.equal(f.queries().rankingQueries, 0);
});

test("学期首末边界走 DATE 口径；昵称缺失不公开实名、账号或后台 ID", async (t) => {
  const f = fixture(t);
  f.configureTerm();
  const result = await publicHomeService.get();
  assert.deepEqual(f.counts[1], {
    where: {
      status: "APPROVED",
      deletedAt: null,
      repairDate: { gte: new Date("2026-09-01T00:00:00Z"), lt: new Date("2027-02-01T00:00:00Z") },
    },
  });
  assert.deepEqual(result.rankings, {
    status: "AVAILABLE",
    items: [{ rank: 1, displayName: "成员", approvedCount: 2 }],
  });
  const json = JSON.stringify(result);
  for (const secret of [
    "private-member-id",
    "私人实名",
    "登录账号",
    "memberProfileId",
    "avatarUrl",
    "userId",
  ]) {
    assert.equal(json.includes(secret), false, secret);
  }
});

test("隐藏姓名时不读取成员资料；实名与昵称模式各自独立", async (t) => {
  const f = fixture(t);
  f.configureTerm();
  f.policy.rankingDisplayName = "HIDDEN";
  assert.equal((await publicHomeService.get()).rankings?.items[0].displayName, "成员");
  assert.equal(f.queries().memberQueries, 0);
  f.policy.rankingDisplayName = "REAL_NAME";
  assert.equal((await publicHomeService.get()).rankings?.items[0].displayName, "私人实名");
  const member = { nickname: " 昵称 ", realName: " 实名 " };
  assert.equal(publicRankingName("NICKNAME", member), "昵称");
  assert.equal(publicRankingName("REAL_NAME", member), "实名");
  assert.equal(publicRankingName("HIDDEN", member), "成员");
});

test("统计失败不隐藏正常排行，排行失败不隐藏正常统计", async (t) => {
  const f = fixture(t);
  f.configureTerm();
  const count = f.db.repairRecord.count;
  f.db.repairRecord.count = async () => {
    throw new Error("stats unavailable");
  };
  const rankingsOnly = await publicHomeService.get();
  assert.equal(rankingsOnly.repairStats, null);
  assert.equal(rankingsOnly.rankings?.items.length, 1);
  f.db.repairRecord.count = count;
  f.db.$queryRaw = async () => {
    throw new Error("ranking unavailable");
  };
  const statsOnly = await publicHomeService.get();
  assert.equal(statsOnly.repairStats?.totalApprovedCount, 7);
  assert.equal(statsOnly.rankings, null);
});

test("首页 DOM：全关隐藏；真实零值、待配置、空榜和启用内容分别展示", () => {
  const render = (data: PublicHomeAnalytics) =>
    renderToStaticMarkup(React.createElement(HomePublicAnalytics, { data }));
  assert.equal(render({ repairStats: null, rankings: null }), "");
  const stats = {
    totalApprovedCount: 0,
    details: {
      termApprovedCount: { value: null, status: "UNCONFIGURED" as const },
      totalApprovedDurationMinutes: 90,
    },
  };
  const pending = render({ repairStats: stats, rankings: { status: "UNCONFIGURED", items: [] } });
  assert.match(pending, /0 台/);
  assert.match(pending, /1.5 小时/);
  assert.match(pending, /本学期排行待配置/);
  assert.equal((pending.match(/class="home-analytics__table"/g) ?? []).length, 2);
  assert.equal((pending.match(/<caption>/g) ?? []).length, 2);
  assert.doesNotMatch(pending, /暂无上榜记录/);
  assert.match(
    render({ repairStats: null, rankings: { status: "AVAILABLE", items: [] } }),
    /暂无上榜记录/,
  );
  const enabled = render({
    repairStats: null,
    rankings: {
      status: "AVAILABLE",
      items: [{ rank: 1, displayName: "公开昵称", approvedCount: 2 }],
    },
  });
  assert.match(enabled, /公开昵称/);
  assert.match(enabled, /第 1 名/);
  assert.match(enabled, /2 次/);
  assert.doesNotMatch(enabled, /累计服务设备/);
});

test("首页公开数据位于 Hero 内；全关时保留文档面板，不重复渲染统计", async () => {
  // Icon 的图形在模块加载时创建，须在测试的 React 全局初始化之后加载 Hero。
  const { Hero } = await import("../../src/components/home/Hero");
  const visible: PublicHomeAnalytics = {
    repairStats: { totalApprovedCount: 7 },
    rankings: {
      status: "AVAILABLE",
      items: [
        { rank: 1, displayName: "成员", approvedCount: 2 },
        { rank: 1, displayName: "成员", approvedCount: 2 },
      ],
    },
  };
  const html = renderToStaticMarkup(React.createElement(Hero, { analytics: visible }));
  assert.match(html, /class="shell hero__inner hero__inner--public"/);
  assert.match(html, /id="hero"[\s\S]*id="public-statistics"/);
  assert.equal((html.match(/id="public-statistics"/g) ?? []).length, 1);
  assert.equal((html.match(/第 1 名 · 成员/g) ?? []).length, 2, "并列和同名不得丢行");
  assert.doesNotMatch(html, /内置文档仓库/);
  const hidden = renderToStaticMarkup(
    React.createElement(Hero, { analytics: { repairStats: null, rankings: null } }),
  );
  assert.doesNotMatch(hidden, /public-statistics|hero__inner--public/);
  assert.match(hidden, /内置文档仓库/);
});
