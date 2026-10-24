import { randomBytes } from "node:crypto";
import { getDb } from "../../src/lib/db/client";
import { permissionsForRoles } from "../../src/lib/auth/permissions";
import type { AuthorizedActor } from "../../src/types/contracts";
import { assertTestDatabase } from "../integration/db-guard";
import { sessionCookie } from "../integration/http-harness";

export const tableFixtureId = (n: number) =>
  `e2140000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const tableFixtureActor: AuthorizedActor = {
  actorType: "USER",
  userId: tableFixtureId(1),
  userStatus: "ACTIVE",
  permissions: permissionsForRoles(["ADMIN"]),
  requestId: "req_i214_table",
};
const scope = { startsWith: "e2140000-" };

export async function cleanupTableQueryFixtures() {
  assertTestDatabase();
  const db = getDb();
  await db.auditLog.deleteMany({
    where: { actorUserId: { in: [tableFixtureId(1), tableFixtureId(2), tableFixtureId(3)] } },
  });
  await db.joinApplicationReview.deleteMany({ where: { applicationId: scope } });
  await db.joinApplication.deleteMany({ where: { id: scope } });
  await db.repairRecordParticipant.deleteMany({ where: { repairRecordId: scope } });
  await db.repairRecord.deleteMany({ where: { id: scope } });
  await db.inviteCode.deleteMany({ where: { id: scope } });
  await db.authSession.deleteMany({ where: { userId: scope } });
  await db.userRole.deleteMany({ where: { userId: scope } });
  await db.passwordCredential.deleteMany({ where: { userId: scope } });
  await db.userIdentity.deleteMany({ where: { userId: scope } });
  await db.memberProfile.deleteMany({ where: { id: scope } });
  await db.user.deleteMany({ where: { id: scope } });
}

/** 专用 _test 库夹具；也供本轮本地前端截图使用，不访问真实账号或发信。 */
export async function prepareTableQueryFixtures() {
  assertTestDatabase();
  await cleanupTableQueryFixtures();
  const db = getDb();
  const now = new Date("2026-10-24T02:00:00.000Z");
  for (const n of [1, 2, 3])
    await db.user.create({
      data: {
        id: tableFixtureId(n),
        status: "ACTIVE",
        displayName: "I214 本地联调",
        createdAt: now,
        updatedAt: now,
      },
    });
  for (const n of [2, 3])
    await db.memberProfile.create({
      data: {
        id: tableFixtureId(n),
        userId: tableFixtureId(n),
        realName: `I214 联调成员${n}`,
        status: "ACTIVE",
        department: n === 2 ? "REPAIR" : "PUBLICITY",
        joinedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
  for (const n of [10, 11, 12, 13]) {
    const passed = n !== 12;
    await db.joinApplication.create({
      data: {
        id: tableFixtureId(n),
        ticketNo: `I214-${n}`,
        recruitmentCycle: "I214-本地联调",
        realName: `I214 报名示例${n}`,
        qqNormalized: `9914214${n}`,
        phoneNormalized: `139921400${n}`,
        status: passed ? "INTERVIEW_PASSED" : "SUBMITTED",
        provisionStatus: passed ? "SUCCEEDED" : "NOT_REQUIRED",
        privacyConsentAt: now,
        submittedAt: now,
        createdAt: now,
        updatedAt: now,
        lastReviewedAt: passed ? new Date(`2026-10-${n === 10 ? "22" : "21"}T01:00:00Z`) : null,
      },
    });
    if (n < 12)
      await db.joinApplicationReview.create({
        data: {
          id: tableFixtureId(n + 100),
          applicationId: tableFixtureId(n),
          result: "PASSED",
          interviewedAt: new Date("2026-10-21T01:00:00Z"),
          reviewerUserId: tableFixtureId(1),
          createdAt: new Date(n === 10 ? "2026-10-24T01:00:00Z" : "2026-10-24T02:00:00Z"),
        },
      });
  }
  // 补记通过备注不能改写首次通过时间。
  await db.joinApplicationReview.create({
    data: {
      id: tableFixtureId(112),
      applicationId: tableFixtureId(10),
      result: "PASSED",
      interviewedAt: now,
      reviewerUserId: tableFixtureId(1),
      internalNote: "本地补记",
      createdAt: new Date("2026-10-24T06:00:00Z"),
    },
  });
  for (const n of [20, 21, 22])
    await db.repairRecord.create({
      data: {
        id: tableFixtureId(n),
        memberProfileId: tableFixtureId(2),
        createRequestKey: `I214-${n}`,
        status: n === 22 ? "DRAFT" : "APPROVED",
        deviceModel: "I214 设备",
        durationMinutes: n,
        repairDate: now,
        result: "COMPLETED",
        createdAt: now,
        updatedAt: now,
      },
    });
  for (const n of [30, 31, 32])
    await db.inviteCode.create({
      data: {
        id: tableFixtureId(n),
        codeDigest: randomBytes(32),
        displayPrefix: `I214-${n}`,
        status: n === 31 ? "REVOKED" : "ACTIVE",
        maxUses: 10,
        usedCount: n - 30,
        createdByUserId: tableFixtureId(1),
        createdAt: now,
        updatedAt: now,
        expiresAt: n === 32 ? new Date("2020-01-01") : null,
      },
    });
  for (const n of [40, 41])
    await db.auditLog.create({
      data: {
        id: tableFixtureId(n),
        actorType: "USER",
        actorUserId: tableFixtureId(1),
        action: "I214.query",
        targetType: "I214Fixture",
        targetId: tableFixtureId(n),
        result: n === 40 ? "SUCCESS" : "FAILURE",
        requestId: `req_i214_${n}`,
        createdAt: now,
      },
    });
  await db.userIdentity.create({
    data: {
      id: tableFixtureId(50),
      userId: tableFixtureId(1),
      type: "EMAIL",
      identifierNormalized: "i214-admin@example.invalid",
      activeEmailKey: `email:${tableFixtureId(1)}`,
      verifiedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
  return { cookie: await sessionCookie(tableFixtureId(1)), actor: tableFixtureActor };
}
