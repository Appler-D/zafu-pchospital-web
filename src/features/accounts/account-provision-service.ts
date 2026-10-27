import { randomUUID } from "node:crypto";

import type { Prisma } from "@/generated/prisma/client";

import { AppError } from "@/lib/api/errors";
import { appendAuditLog } from "@/lib/audit/audit-service";
import { getDb } from "@/lib/db/client";
import { inSerializableTransaction } from "@/lib/db/transaction";
import { initialPasswordFromQq, normalizePhone, normalizeQq } from "@/lib/security/normalization";
import type { AccountProvisionServiceContract, ProvisionResult } from "@/types/contracts";
import {
  ensureMemberProfile,
  grantMemberRole,
  resolveOrCreateUser,
  setInitialPassword,
} from "@/features/accounts/account-repository";
import { enqueueAccountNotification } from "@/features/email/account-notification-service";
import { claimHistoryForNewMember } from "@/features/repairs/repair-history-import-service";
import { parseMemberDepartment } from "@/features/members/member-department";

export class AccountProvisionService implements AccountProvisionServiceContract {
  async provisionFromApplication(
    applicationId: string,
    idempotencyKey: string,
  ): Promise<ProvisionResult> {
    try {
      const result = await inSerializableTransaction((tx) =>
        this.provisionInTransaction(tx, applicationId, idempotencyKey),
      );
      return await this.finishProvision(result);
    } catch (error) {
      if (error instanceof AppError && error.code === "RESOURCE_NOT_FOUND") throw error;
      const code = error instanceof AppError ? error.code : "ACCOUNT_PROVISION_FAILED";
      await getDb().accountProvision.updateMany({
        where: {
          sourceType: "JOIN_APPLICATION",
          sourceId: applicationId,
          status: { not: "SUCCEEDED" },
        },
        data: { status: "FAILED", lastErrorCode: code, attemptCount: { increment: 1 } },
      });
      await getDb().joinApplication.updateMany({
        where: {
          id: applicationId,
          status: "INTERVIEW_PASSED",
          provisionStatus: { not: "SUCCEEDED" },
        },
        data: { provisionStatus: "FAILED" },
      });
      await inSerializableTransaction((tx) =>
        appendAuditLog(tx, {
          actor: { requestId: `provision:${applicationId}` },
          actorType: "SYSTEM",
          action: "account.provision.failed",
          targetType: "AccountProvision",
          targetId: applicationId,
          result: "FAILURE",
          errorCode: code,
        }),
      );
      throw error;
    }
  }

  /** 首次审核复用同一事务；历史已通过任务继续由原发放入口负责失败记录与重试。 */
  async provisionInTransaction(
    tx: Prisma.TransactionClient,
    applicationId: string,
    idempotencyKey: string,
  ) {
    await tx.$queryRaw`SELECT id FROM join_applications WHERE id = ${applicationId} FOR UPDATE`;
    const application = await tx.joinApplication.findUnique({ where: { id: applicationId } });
    if (!application || application.deletedAt) {
      throw new AppError("RESOURCE_NOT_FOUND", "报名记录不存在");
    }
    if (application.status !== "INTERVIEW_PASSED") {
      throw new AppError("STATE_TRANSITION_INVALID", "报名尚未通过面试");
    }
    // 锁后复核：并发幂等重入不能重做成功建档，也不能重复创建通知。
    const fresh = await tx.accountProvision.findUnique({
      where: {
        sourceType_sourceId: { sourceType: "JOIN_APPLICATION", sourceId: applicationId },
      },
    });
    if (fresh?.status === "SUCCEEDED")
      return {
        completed: fresh,
        replayed: true,
        initializationSecret: "",
        passwordCreated: false,
        memberProfileId: fresh.memberProfileId!,
        realName: application.realName,
      };
    const initializationSecret = initialPasswordFromQq(application.qqNormalized);
    const provision = await tx.accountProvision.upsert({
      where: {
        sourceType_sourceId: { sourceType: "JOIN_APPLICATION", sourceId: applicationId },
      },
      update: { status: "PENDING", attemptCount: { increment: 1 }, lastErrorCode: null },
      create: {
        id: randomUUID(),
        sourceType: "JOIN_APPLICATION",
        sourceId: applicationId,
        idempotencyKey,
        status: "PENDING",
        attemptCount: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    if (provision.idempotencyKey !== idempotencyKey) {
      throw new AppError("IDEMPOTENCY_CONFLICT", "幂等键与已有发放任务不一致");
    }

    const userId = await resolveOrCreateUser(
      tx,
      {
        qq: normalizeQq(application.qqNormalized),
        phone: normalizePhone(application.phoneNormalized),
      },
      application.realName,
    );
    const previousProfile = await tx.memberProfile.findUnique({ where: { userId } });
    const memberProfileId = await ensureMemberProfile(tx, {
      userId,
      realName: application.realName,
      // 学号 / 班级：有效新值沿既有发放更新语义写入档案；
      // 历史报名的 NULL / 空白转为 `undefined`（不更新该字段），不能清空档案里已有的有效值。
      studentId: blankToUndefined(application.studentId),
      className: blankToUndefined(application.className),
      // 以审核事务保存的部门为准；历史 NULL 新建用默认值，复用保留当前归属。
      department:
        application.admittedDepartment === null
          ? undefined
          : parseMemberDepartment(application.admittedDepartment, "admittedDepartment"),
    });
    await grantMemberRole(tx, {
      userId,
      sourceType: "JOIN_APPLICATION",
      sourceId: applicationId,
    });
    const passwordCreated = await setInitialPassword(tx, userId, initializationSecret);
    const completed = await tx.accountProvision.update({
      where: { id: provision.id },
      data: { status: "SUCCEEDED", userId, memberProfileId, completedAt: new Date() },
    });
    await tx.joinApplication.update({
      where: { id: applicationId },
      data: { provisionStatus: "SUCCEEDED" },
    });
    const credential = await tx.passwordCredential.findUniqueOrThrow({ where: { userId } });
    await enqueueAccountNotification(tx, {
      provisionId: provision.id,
      applicationId,
      userId,
      recipientEmail: application.email,
      qqNormalized: application.qqNormalized,
      credentialCreated: passwordCreated,
      credentialVersion: credential.credentialVersion,
    });
    await appendAuditLog(tx, {
      actor: { requestId: `provision:${provision.id}` },
      actorType: "SYSTEM",
      action: "account.provision.succeeded",
      targetType: "AccountProvision",
      targetId: provision.id,
      result: "SUCCESS",
      before: previousProfile
        ? {
            memberProfileId: previousProfile.id,
            department: previousProfile.department,
            version: previousProfile.version,
          }
        : undefined,
      after: {
        sourceType: provision.sourceType,
        sourceId: applicationId,
        userId,
        memberProfileId,
        department: application.admittedDepartment ?? previousProfile?.department ?? "REPAIR",
      },
    });
    return {
      completed,
      replayed: false,
      passwordCreated,
      memberProfileId,
      realName: application.realName,
      initializationSecret,
    };
  }

  /** 事务提交后才认领历史记录；该辅助动作失败不影响发放结果。 */
  async finishProvision(
    result: Awaited<ReturnType<AccountProvisionService["provisionInTransaction"]>>,
  ) {
    if (result.replayed) return toResult(result.completed);
    // 建档后按姓名补录历史暂存行。独立事务且内部吞异常：
    // 历史数据的问题不能让发放失败，失败的暂存行保留、重跑导入也能补。
    await claimHistoryForNewMember({
      memberProfileId: result.memberProfileId,
      realName: result.realName,
      actor: { requestId: `provision:${result.completed.id}` },
      actorType: "SYSTEM",
    });
    return {
      ...toResult(result.completed),
      ...(result.passwordCreated ? { initializationSecret: result.initializationSecret } : {}),
    };
  }

  async provisionFromInvite(
    redemptionId: string,
    idempotencyKey: string,
  ): Promise<ProvisionResult> {
    const provision = await getDb().accountProvision.findUnique({
      where: { sourceType_sourceId: { sourceType: "INVITE_REDEMPTION", sourceId: redemptionId } },
    });
    if (!provision || provision.idempotencyKey !== idempotencyKey) {
      throw new AppError("RESOURCE_NOT_FOUND", "邀请码发放记录不存在");
    }
    return toResult(provision);
  }
}

function toResult(provision: {
  id: string;
  status: string;
  userId: string | null;
  memberProfileId: string | null;
  attemptCount: number;
  lastErrorCode: string | null;
}): ProvisionResult {
  return {
    id: provision.id,
    status: provision.status as ProvisionResult["status"],
    userId: provision.userId,
    memberProfileId: provision.memberProfileId,
    attemptCount: provision.attemptCount,
    lastErrorCode: provision.lastErrorCode,
  };
}

/**
 * 历史报名上的学号 / 班级是 `NULL`（未填写）：转为 `undefined` 让
 * `ensureMemberProfile` 跳过该字段，而不是写入 `null` 把档案里的有效值抹掉。
 */
function blankToUndefined(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export const accountProvisionService = new AccountProvisionService();
