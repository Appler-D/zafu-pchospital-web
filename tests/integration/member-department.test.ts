import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import {
  PATCH as updateRoute,
  GET as detailRoute,
} from "../../src/app/api/v1/admin/members/[id]/route";
import { GET as listRoute, POST as createRoute } from "../../src/app/api/v1/admin/members/route";
import { POST as reviewRoute } from "../../src/app/api/v1/admin/join-applications/[id]/reviews/route";
import { accountProvisionService } from "../../src/features/accounts/account-provision-service";
import { ensureMemberProfile } from "../../src/features/accounts/account-repository";
import { inviteCodeService } from "../../src/features/invitations/invite-code-service";
import { memberService } from "../../src/features/members/member-service";
import { joinApplicationService } from "../../src/features/recruitment/join-application-service";
import { AppError } from "../../src/lib/api/errors";
import { permissionsForRoles } from "../../src/lib/auth/permissions";
import { disconnectDb, getDb } from "../../src/lib/db/client";
import { inSerializableTransaction } from "../../src/lib/db/transaction";
import {
  MemberDepartment,
  type AuthorizedActor,
  type MemberUpdateView,
} from "../../src/types/contracts";
import { integrationTestsEnabled } from "./db-guard";
import { callRoute, sessionCookie } from "./http-harness";

const enabled = integrationTestsEnabled();
const dbTest = enabled ? test : test.skip;
const adminId = "e1710000-0000-4000-8000-000000000001";
const prefix = "I171 ";
const admin: AuthorizedActor = {
  userId: adminId,
  actorType: "USER",
  userStatus: "ACTIVE",
  permissions: permissionsForRoles(["ADMIN"]),
  requestId: "req_i171",
};
let cookie = "";
let sequence = 0;

function identity() {
  const n = String(++sequence).padStart(8, "0");
  return { qq: `917${n}`, phone: `137${n}` };
}

async function cleanup() {
  const db = getDb();
  const profiles = await db.memberProfile.findMany({ where: { realName: { startsWith: prefix } } });
  const userIds = [adminId, ...profiles.map((row) => row.userId)];
  const applications = await db.joinApplication.findMany({ where: { recruitmentCycle: "I171" } });
  const applicationIds = applications.map((row) => row.id);
  const provisions = await db.accountProvision.findMany({
    where: { OR: [{ sourceId: { in: applicationIds } }, { userId: { in: userIds } }] },
  });
  await db.auditLog.deleteMany({
    where: {
      OR: [
        { actorUserId: { in: userIds } },
        {
          targetId: {
            in: [
              ...applicationIds,
              ...profiles.map((row) => row.id),
              ...provisions.map((row) => row.id),
            ],
          },
        },
      ],
    },
  });
  await db.accountNotification.deleteMany({ where: { applicationId: { in: applicationIds } } });
  await db.accountProvision.deleteMany({ where: { id: { in: provisions.map((row) => row.id) } } });
  await db.inviteCodeRedemption.deleteMany({ where: { userId: { in: userIds } } });
  await db.inviteCode.deleteMany({ where: { createdByUserId: adminId } });
  await db.joinApplicationReview.deleteMany({ where: { applicationId: { in: applicationIds } } });
  await db.joinApplication.deleteMany({ where: { id: { in: applicationIds } } });
  await db.authSession.deleteMany({ where: { userId: { in: userIds } } });
  await db.passwordCredential.deleteMany({ where: { userId: { in: userIds } } });
  await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await db.userIdentity.deleteMany({ where: { userId: { in: userIds } } });
  await db.memberProfile.deleteMany({ where: { id: { in: profiles.map((row) => row.id) } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

before(async () => {
  if (!enabled) return;
  await cleanup();
  const now = new Date();
  await getDb().user.create({
    data: { id: adminId, status: "ACTIVE", createdAt: now, updatedAt: now },
  });
  cookie = await sessionCookie(adminId);
});
after(async () => {
  if (!enabled) return;
  try {
    await cleanup();
  } finally {
    await disconnectDb();
  }
});

async function createMember(department?: MemberDepartment) {
  const contact = identity();
  const result = await memberService.create(
    {
      ...contact,
      realName: `${prefix}成员${sequence}`,
      department,
      idempotencyKey: randomUUID(),
    },
    admin,
  );
  return { ...result.member, ...contact };
}

async function application(contact = identity()) {
  return joinApplicationService.submit(
    {
      ...contact,
      realName: `${prefix}报名${sequence}`,
      recruitmentCycle: "I171",
      email: "i171@example.com",
      studentId: `00171-${sequence}`,
      className: "计科171",
      privacyConsent: true,
    },
    { requestId: "req_i171_submit" },
  );
}

async function prepareHistoricalPass(id: string, admittedDepartment: MemberDepartment) {
  await getDb().joinApplication.update({
    where: { id },
    data: {
      status: "INTERVIEW_PASSED",
      provisionStatus: "PENDING",
      admittedDepartment,
      reviews: {
        create: {
          id: randomUUID(),
          result: "PASSED",
          interviewedAt: new Date(),
          reviewerUserId: adminId,
          createdAt: new Date(),
        },
      },
    },
  });
  await getDb().accountProvision.create({
    data: {
      id: randomUUID(),
      sourceType: "JOIN_APPLICATION",
      sourceId: id,
      idempotencyKey: `i171:${id}`,
      status: "PENDING",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
}

function reviewInput(id: string, admittedDepartment?: MemberDepartment) {
  return {
    applicationId: id,
    result: "PASSED" as const,
    admittedDepartment,
    interviewedAt: new Date().toISOString(),
    idempotencyKey: `i171:${id}`,
  };
}

async function profileForApplication(id: string) {
  const provision = await getDb().accountProvision.findUniqueOrThrow({
    where: { sourceType_sourceId: { sourceType: "JOIN_APPLICATION", sourceId: id } },
  });
  return getDb().memberProfile.findUniqueOrThrow({ where: { id: provision.memberProfileId! } });
}

function errorCode(code: string) {
  return (error: unknown) => error instanceof AppError && error.code === code;
}

dbTest(
  "管理员创建三部门与缺省；真实 HTTP 列表、详情、修改响应贯通，拒绝越权与版本冲突",
  async () => {
    const defaultMember = await createMember();
    assert.equal(defaultMember.department, "REPAIR");
    for (const department of MemberDepartment) {
      const member = await createMember(department);
      assert.equal(member.department, department);
    }
    const member = await getDb().memberProfile.findUniqueOrThrow({
      where: { id: defaultMember.id },
    });
    const patch = (body: unknown, auth = cookie) =>
      callRoute(updateRoute, `http://localhost/api/v1/admin/members/${member.id}`, {
        method: "PATCH",
        params: { id: member.id },
        headers: { cookie: auth },
        body,
      });
    for (const department of [null, "", [], "维修部", "OTHER"]) {
      const result = await patch({ department, version: member.version });
      assert.equal(result.status, 400);
      assert.equal((result.json.error as { code: string }).code, "VALIDATION_FAILED");
    }
    const updated = await patch({ department: "OFFICE", version: member.version });
    assert.equal(updated.status, 200);
    const data = updated.json.data as MemberUpdateView;
    assert.equal(data.department, "OFFICE");
    assert.equal(data.version, member.version + 1);
    assert.equal((await patch({ department: "PUBLICITY", version: member.version })).status, 409);
    assert.equal(
      (await memberService.update(member.id, { nickname: "I171", version: data.version }, admin))
        .department,
      "OFFICE",
    );
    const detail = await callRoute(
      detailRoute,
      `http://localhost/api/v1/admin/members/${member.id}`,
      { params: { id: member.id }, headers: { cookie } },
    );
    assert.equal((detail.json.data as MemberUpdateView).department, "OFFICE");
    const list = await callRoute(
      listRoute,
      "http://localhost/api/v1/admin/members?query=I171&pageSize=100",
      { headers: { cookie } },
    );
    assert.equal(
      (list.json.data as MemberUpdateView[]).find((row) => row.id === member.id)?.department,
      "OFFICE",
    );
    const audit = await getDb().auditLog.findFirstOrThrow({
      where: { targetId: member.id, action: "member.profile.updated" },
      orderBy: { createdAt: "asc" },
    });
    assert.equal((audit.beforeSummary as { department: string }).department, "REPAIR");
    assert.equal((audit.afterSummary as { department: string }).department, "OFFICE");
    // sessionCookie 会创建角色；移除本夹具的既有授权后再调用，避免重复 activeKey。
    await getDb().userRole.deleteMany({ where: { userId: member.userId } });
    const memberCookie = await sessionCookie(member.userId, "MEMBER");
    assert.equal(
      (await patch({ department: "PUBLICITY", version: data.version + 1 }, memberCookie)).status,
      403,
    );
    assert.equal(
      (await getDb().memberProfile.findUniqueOrThrow({ where: { id: member.id } })).department,
      "OFFICE",
    );
    const deniedReview = await callRoute(
      reviewRoute,
      `http://localhost/api/v1/admin/join-applications/${member.id}/reviews`,
      {
        method: "POST",
        headers: { cookie: memberCookie },
        params: { id: member.id },
        body: reviewInput(member.id, "OFFICE"),
      },
    );
    assert.equal(deniedReview.status, 403);
    const created = await callRoute(createRoute, "http://localhost/api/v1/admin/members", {
      method: "POST",
      headers: { cookie },
      body: {
        ...identity(),
        realName: `${prefix}HTTP`,
        department: "PUBLICITY",
        idempotencyKey: randomUUID(),
      },
    });
    assert.equal(created.status, 201);
    assert.equal(
      (created.json.data as { member: MemberUpdateView }).member.department,
      "PUBLICITY",
    );
  },
);

dbTest("首次通过须有效部门；拒绝不通过携带部门；审核、发放与审计保持一致", async () => {
  const record = await application();
  for (const department of [undefined, null, "", "OTHER", ["REPAIR"]]) {
    const result = await callRoute(
      reviewRoute,
      `http://localhost/api/v1/admin/join-applications/${record.id}/reviews`,
      {
        method: "POST",
        headers: { cookie },
        params: { id: record.id },
        body: { ...reviewInput(record.id), admittedDepartment: department },
      },
    );
    assert.equal(result.status, 400);
    assert.equal((result.json.error as { code: string }).code, "VALIDATION_FAILED");
  }
  assert.equal(
    await getDb().joinApplicationReview.count({ where: { applicationId: record.id } }),
    0,
  );
  assert.equal(await getDb().accountProvision.count({ where: { sourceId: record.id } }), 0);
  await assert.rejects(
    joinApplicationService.review(
      { ...reviewInput(record.id, "OFFICE"), result: "REJECTED" },
      admin,
    ),
    errorCode("VALIDATION_FAILED"),
  );
  const rejected = await joinApplicationService.review(
    { ...reviewInput(record.id), result: "REJECTED" },
    admin,
  );
  assert.equal(rejected.admittedDepartment, null);
  for (const department of MemberDepartment) {
    const receipt = await application();
    const result = await callRoute(
      reviewRoute,
      `http://localhost/api/v1/admin/join-applications/${receipt.id}/reviews`,
      {
        method: "POST",
        headers: { cookie },
        params: { id: receipt.id },
        body: reviewInput(receipt.id, department),
      },
    );
    assert.equal(result.status, 200);
    assert.equal(
      (result.json.data as { admittedDepartment: string }).admittedDepartment,
      department,
    );
    assert.equal((await profileForApplication(receipt.id)).department, department);
    const audit = await getDb().auditLog.findFirstOrThrow({
      where: { action: "join.review.created", targetId: receipt.id },
    });
    assert.equal(
      (audit.afterSummary as { admittedDepartment: string }).admittedDepartment,
      department,
    );
  }
});

dbTest("发放失败保留首次部门；重试成功后重复通过、补记备注与成功重放不覆盖管理员变更", async () => {
  const existing = await createMember("REPAIR");
  const record = await application(existing);
  // 历史版本已通过、尚未完成发放；新版首次审核遇到重复成员会直接拦截。
  await prepareHistoricalPass(record.id, "PUBLICITY");
  await getDb().user.update({ where: { id: existing.userId }, data: { status: "DISABLED" } });
  await assert.rejects(
    accountProvisionService.provisionFromApplication(record.id, `i171:${record.id}`),
    errorCode("ACCOUNT_IDENTITY_CONFLICT"),
  );
  const failed = await getDb().joinApplication.findUniqueOrThrow({ where: { id: record.id } });
  assert.equal(failed.provisionStatus, "FAILED");
  assert.equal(failed.admittedDepartment, "PUBLICITY");
  assert.equal(
    (await getDb().memberProfile.findUniqueOrThrow({ where: { id: existing.id } })).department,
    "REPAIR",
  );
  await getDb().user.update({ where: { id: existing.userId }, data: { status: "ACTIVE" } });
  await joinApplicationService.retryProvision(record.id, admin);
  const profile = await profileForApplication(record.id);
  assert.equal(profile.id, existing.id);
  assert.equal(profile.department, "PUBLICITY");
  assert.equal(profile.version, 2);
  const provisionAudit = await getDb().auditLog.findFirstOrThrow({
    where: {
      action: "account.provision.succeeded",
      targetId: (
        await getDb().accountProvision.findUniqueOrThrow({
          where: { sourceType_sourceId: { sourceType: "JOIN_APPLICATION", sourceId: record.id } },
        })
      ).id,
    },
  });
  assert.equal((provisionAudit.beforeSummary as { department: string }).department, "REPAIR");
  assert.equal((provisionAudit.afterSummary as { department: string }).department, "PUBLICITY");
  await assert.rejects(
    memberService.update(profile.id, { department: "OFFICE", version: 1 }, admin),
    errorCode("MEMBER_PROFILE_VERSION_CONFLICT"),
  );
  await memberService.update(profile.id, { department: "OFFICE", version: profile.version }, admin);
  await joinApplicationService.review(reviewInput(record.id, "REPAIR"), admin);
  await joinApplicationService.review(
    { ...reviewInput(record.id), internalNote: "补记部门不变" },
    admin,
  );
  await accountProvisionService.provisionFromApplication(record.id, `i171:${record.id}`);
  const final = await profileForApplication(record.id);
  assert.equal(final.department, "OFFICE");
  assert.equal(final.version, 3);
  assert.equal(
    (await joinApplicationService.get(record.id, admin)).admittedDepartment,
    "PUBLICITY",
  );
  assert.equal(
    await getDb().joinApplicationReview.count({ where: { applicationId: record.id } }),
    2,
  );
  assert.equal(await getDb().accountProvision.count({ where: { sourceId: record.id } }), 1);
});

dbTest("重复通过在失败任务上沿用首次部门；历史空录取部门新建默认、复用保留", async () => {
  const existing = await createMember("OFFICE");
  const receipt = await application(existing);
  await prepareHistoricalPass(receipt.id, "PUBLICITY");
  await getDb().user.update({ where: { id: existing.userId }, data: { status: "DISABLED" } });
  await assert.rejects(
    accountProvisionService.provisionFromApplication(receipt.id, `i171:${receipt.id}`),
  );
  await getDb().user.update({ where: { id: existing.userId }, data: { status: "ACTIVE" } });
  await joinApplicationService.review(reviewInput(receipt.id, "REPAIR"), admin);
  assert.equal((await profileForApplication(receipt.id)).department, "PUBLICITY");
  for (const reuse of [false, true]) {
    const member = reuse ? await createMember("OFFICE") : undefined;
    const record = await application(member);
    await getDb().joinApplication.update({
      where: { id: record.id },
      data: { status: "INTERVIEW_PASSED", provisionStatus: "PENDING" },
    });
    await accountProvisionService.provisionFromApplication(record.id, `i171:${record.id}`);
    const profile = await profileForApplication(record.id);
    assert.equal(profile.department, reuse ? "OFFICE" : "REPAIR");
    assert.equal(profile.version, 1);
    assert.equal(
      (await getDb().joinApplication.findUniqueOrThrow({ where: { id: record.id } }))
        .admittedDepartment,
      null,
    );
  }
});

dbTest("邀请码注册默认维修部；共享建档未提供部门不覆盖既有归属", async () => {
  const code = await inviteCodeService.create({ maxUses: 1 }, admin);
  const registration = await inviteCodeService.redeem(
    {
      ...identity(),
      realName: `${prefix}邀请码`,
      studentId: "00171",
      className: "计科171",
      password: "I171-Password",
      code: code.plainCode,
      idempotencyKey: randomUUID(),
    },
    { requestId: "req_i171_invite" },
  );
  const profile = await getDb().memberProfile.findUniqueOrThrow({
    where: { id: registration.memberProfileId },
  });
  assert.equal(profile.department, "REPAIR");
  await memberService.update(profile.id, { department: "OFFICE", version: profile.version }, admin);
  await inSerializableTransaction((tx) =>
    ensureMemberProfile(tx, { userId: profile.userId, realName: profile.realName }),
  );
  const unchanged = await getDb().memberProfile.findUniqueOrThrow({ where: { id: profile.id } });
  assert.equal(unchanged.department, "OFFICE");
  assert.equal(unchanged.version, 2);
});
