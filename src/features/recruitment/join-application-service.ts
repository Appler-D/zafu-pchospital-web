import { randomBytes, randomUUID } from "node:crypto";

import {
  accountNotificationService,
  toAccountNotificationView,
} from "@/features/email/account-notification-service";
import { accountProvisionService } from "@/features/accounts/account-provision-service";
import { parseMemberDepartment } from "@/features/members/member-department";
import { assertNoActiveMemberConflict } from "@/features/recruitment/member-conflicts";
import { ACCOUNT_NOTIFICATION_KIND } from "@/config/account-notification";
import type { AccountNotification, JoinApplication } from "@/generated/prisma/client";
import { joinQueryRows, joinQueryTotal, joinQuerySummary } from "./join-application-query";
import { AppError } from "@/lib/api/errors";
import { appendAuditLog } from "@/lib/audit/audit-service";
import { maskPhone, maskQq } from "@/lib/audit/redaction";
import { requirePermission } from "@/lib/auth/permissions";
import { getDb } from "@/lib/db/client";
import { inSerializableTransaction } from "@/lib/db/transaction";
import {
  CLASS_NAME_LENGTH_MESSAGE,
  CLASS_NAME_MAX_LENGTH,
  normalizePhone,
  normalizeEmail,
  normalizeQq,
  PERSON_NAME_LENGTH_MESSAGE,
  STUDENT_ID_LENGTH_MESSAGE,
  STUDENT_ID_MAX_LENGTH,
  trimPersonName,
  trimRequiredTextField,
} from "@/lib/security/normalization";
import type {
  AuthorizedActor,
  CorrectJoinNotificationEmailInput,
  JoinApplicationDetail,
  JoinApplicationListInput,
  JoinApplicationServiceContract,
  JoinApplicationSummary,
  JoinApplicationView,
  JoinNotificationEmailCorrection,
  JoinReceipt,
  ProvisionView,
  PublicRequestContext,
  ReviewJoinApplicationInput,
  SubmitJoinApplicationInput,
} from "@/types/contracts";

export class JoinApplicationService implements JoinApplicationServiceContract {
  async list(input: JoinApplicationListInput, actor: AuthorizedActor) {
    requirePermission(actor, "join:read");
    const page = Number.isInteger(input.page) && input.page > 0 ? input.page : 1;
    const pageSize =
      Number.isInteger(input.pageSize) && input.pageSize > 0 && input.pageSize <= 100
        ? input.pageSize
        : 20;
    const [records, total, summary] = await Promise.all([
      joinQueryRows(input, pageSize, (page - 1) * pageSize),
      joinQueryTotal(input),
      joinQuerySummary(input),
    ]);
    const items: JoinApplicationSummary[] = records.map((record) => ({
      ...toView(record),
      approvedAt: record.approvedAt?.toISOString() ?? null,
      ticketNo: record.ticketNo,
      recruitmentCycle: record.recruitmentCycle,
      realName: record.realName,
      qqMasked: maskQq(record.qqNormalized),
      phoneMasked: maskPhone(record.phoneNormalized),
      submittedAt: record.submittedAt.toISOString(),
    }));
    return {
      items,
      summary,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    };
  }

  async get(applicationId: string, actor: AuthorizedActor): Promise<JoinApplicationDetail> {
    requirePermission(actor, "join:read");
    const record = await getDb().joinApplication.findUnique({
      where: { id: applicationId },
      include: { reviews: { orderBy: { createdAt: "desc" } } },
    });
    if (!record || record.deletedAt) throw new AppError("RESOURCE_NOT_FOUND", "报名记录不存在");
    // 需求 §45 明确「查看完整报名敏感信息」必须留痕：`get` 是**唯一**返回报名 QQ / 手机号 / 通知邮箱
    // 明文的入口（列表只给脱敏值），与成员详情的 `member.detail.viewed` 同一处理。
    // 缺这条记录时，谁在什么时候看过报名者的联系方式就无法追溯。
    await inSerializableTransaction((tx) =>
      appendAuditLog(tx, {
        actor,
        actorType: actor.actorType,
        actorUserId: actor.userId,
        action: "join.application.detail.viewed",
        targetType: "JoinApplication",
        targetId: record.id,
        result: "SUCCESS",
        after: { ticketNo: record.ticketNo, recruitmentCycle: record.recruitmentCycle },
      }),
    );
    return {
      ...toView(record),
      ticketNo: record.ticketNo,
      recruitmentCycle: record.recruitmentCycle,
      realName: record.realName,
      studentId: record.studentId,
      className: record.className,
      qq: record.qqNormalized,
      phone: record.phoneNormalized,
      email: record.email,
      notification: await accountNotificationService.get(applicationId, actor),
      selfIntroduction: record.selfIntroduction,
      preferredDirection: record.preferredDirection,
      applicantRemark: record.applicantRemark,
      submittedAt: record.submittedAt.toISOString(),
      reviews: record.reviews.map((review) => ({
        id: review.id,
        result: review.result,
        interviewedAt: review.interviewedAt.toISOString(),
        internalNote: review.internalNote,
      })),
    };
  }

  /**
   * 更正报名通知邮箱。
   *
   * 报名邮箱只作通知用（账号邮箱仍由登录后验证绑定），但填错会让面试 / 账号通知
   * 发错地址。按通知任务状态分级：
   * - 无任务：只改报名记录，后续建档入队自然用新地址；
   * - 待发送 / 明确失败：报名记录与任务收件地址一起改（失败任务仍由管理员手动重试）；
   * - 发送中：在途任务无法改地址，直接 409，等结果出来再处理；
   * - 已交发信服务 / 结果未知：只改报名记录，**不改任务、不重发** —— 已发出或无法
   *   确认的通知不能伪装成「发给了新地址」，由管理员核查后走人工恢复。
   */
  async correctNotificationEmail(
    applicationId: string,
    input: CorrectJoinNotificationEmailInput,
    actor: AuthorizedActor,
  ): Promise<JoinNotificationEmailCorrection> {
    requirePermission(actor, "join:review");
    const email = normalizeEmail(input.email);
    return inSerializableTransaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM join_applications WHERE id = ${applicationId} FOR UPDATE`;
      const application = await tx.joinApplication.findUnique({ where: { id: applicationId } });
      if (!application || application.deletedAt) {
        throw new AppError("RESOURCE_NOT_FOUND", "报名记录不存在");
      }
      const candidate = await tx.accountNotification.findFirst({
        where: { applicationId, kind: ACCOUNT_NOTIFICATION_KIND },
        select: { id: true },
      });
      let notification: AccountNotification | null = null;
      if (candidate) {
        await tx.$queryRaw`SELECT id FROM account_notifications WHERE id = ${candidate.id} FOR UPDATE`;
        notification = await tx.accountNotification.findUniqueOrThrow({
          where: { id: candidate.id },
        });
      }
      if (notification?.status === "SENDING") {
        throw new AppError("STATE_TRANSITION_INVALID", "通知正在发送，请等待结果后再更正");
      }
      const recipientUpdatable = Boolean(
        notification && (notification.status === "PENDING" || notification.status === "FAILED"),
      );
      const changed =
        application.email !== email ||
        Boolean(notification && recipientUpdatable && notification.recipientEmail !== email);
      if (changed) {
        if (recipientUpdatable && notification) {
          notification = await tx.accountNotification.update({
            where: { id: notification.id },
            data: { recipientEmail: email },
          });
        }
        await tx.joinApplication.update({ where: { id: applicationId }, data: { email } });
        // 审计摘要在写入时统一脱敏（`redactAuditSummary` 对 email 键打码）。
        await appendAuditLog(tx, {
          actor,
          actorType: actor.actorType,
          actorUserId: actor.userId,
          action: "join.application.notification_email.updated",
          targetType: "JoinApplication",
          targetId: applicationId,
          result: "SUCCESS",
          before: { email: application.email },
          after: {
            email,
            notificationStatus: notification?.status ?? null,
            recipientUpdated: recipientUpdatable,
          },
        });
      }
      return {
        email,
        notification: notification ? toAccountNotificationView(notification) : null,
      };
    });
  }

  async submit(
    input: SubmitJoinApplicationInput,
    context: PublicRequestContext,
  ): Promise<JoinReceipt> {
    const { realName, studentId, className } = validateSubmission(input);
    const email = normalizeEmail(input.email);
    const qqNormalized = normalizeQq(input.qq);
    const phoneNormalized = normalizePhone(input.phone);
    const duplicate = await findDuplicate(input.recruitmentCycle, qqNormalized, phoneNormalized);
    if (duplicate) return duplicateReceipt(duplicate);

    const now = new Date();
    try {
      return await inSerializableTransaction(async (tx) => {
        const record = await tx.joinApplication.create({
          data: {
            id: randomUUID(),
            ticketNo: `JA-${randomBytes(12).toString("hex").toUpperCase()}`,
            recruitmentCycle: input.recruitmentCycle,
            realName,
            studentId,
            className,
            qqNormalized,
            phoneNormalized,
            email,
            selfIntroduction: cleanOptional(input.selfIntroduction),
            preferredDirection: cleanOptional(input.preferredDirection),
            applicantRemark: cleanOptional(input.applicantRemark),
            status: "SUBMITTED",
            provisionStatus: "NOT_REQUIRED",
            privacyConsentAt: now,
            submittedAt: now,
            createdAt: now,
            updatedAt: now,
          },
        });
        await appendAuditLog(tx, {
          actor: context,
          actorType: "SYSTEM",
          action: "join.application.submitted",
          targetType: "JoinApplication",
          targetId: record.id,
          result: "SUCCESS",
          after: {
            recruitmentCycle: input.recruitmentCycle,
            qq: qqNormalized,
            phone: phoneNormalized,
          },
        });
        return toReceipt(record, false);
      });
    } catch (error) {
      if (hasPrismaCode(error, "P2002")) {
        const raced = await findDuplicate(input.recruitmentCycle, qqNormalized, phoneNormalized);
        if (raced) return duplicateReceipt(raced);
      }
      throw error;
    }
  }

  async review(
    input: ReviewJoinApplicationInput,
    actor: AuthorizedActor,
  ): Promise<JoinApplicationView> {
    requirePermission(actor, "join:review");
    const admittedDepartment =
      input.admittedDepartment === undefined
        ? undefined
        : parseMemberDepartment(input.admittedDepartment, "admittedDepartment");
    if (input.result !== "PASSED" && admittedDepartment !== undefined) {
      throw new AppError("VALIDATION_FAILED", "未通过面试时不能设置录取部门", {
        fieldErrors: { admittedDepartment: ["仅面试通过时填写录取部门"] },
      });
    }
    const interviewedAt = new Date(input.interviewedAt);
    if (Number.isNaN(interviewedAt.getTime())) {
      throw new AppError("VALIDATION_FAILED", "面试时间格式无效");
    }
    if (input.internalNote && input.internalNote.length > 2000) {
      throw new AppError("VALIDATION_FAILED", "内部备注不能超过 2000 字");
    }

    const prepared = await inSerializableTransaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM join_applications WHERE id = ${input.applicationId} FOR UPDATE`;
      const application = await tx.joinApplication.findUnique({
        where: { id: input.applicationId },
      });
      if (!application || application.deletedAt) {
        throw new AppError("RESOURCE_NOT_FOUND", "报名记录不存在");
      }
      if (application.status === "INTERVIEW_PASSED" && input.result === "PASSED") {
        // 重复提交「通过」不再走状态流转（否则状态回退、重复建发放任务），但**备注不能丢**：
        // 带备注时按「补记一条面试记录」落库；不带备注才是真正的重复提交，幂等返回。
        // （此前一律直接返回，界面上表现为「填了备注、提示成功、备注却不在」。）
        const note = cleanOptional(input.internalNote);
        if (!note) return { application, provision: null };
        await tx.joinApplicationReview.create({
          data: {
            id: randomUUID(),
            applicationId: application.id,
            result: input.result,
            interviewedAt,
            reviewerUserId: actor.userId!,
            internalNote: note,
            createdAt: new Date(),
          },
        });
        await appendAuditLog(tx, {
          actor,
          actorType: actor.actorType,
          actorUserId: actor.userId,
          action: "join.review.created",
          targetType: "JoinApplication",
          targetId: application.id,
          result: "SUCCESS",
          before: { status: application.status, provisionStatus: application.provisionStatus },
          after: {
            status: application.status,
            provisionStatus: application.provisionStatus,
            noteOnly: true,
          },
        });
        return { application, provision: null };
      }
      if (application.status !== "SUBMITTED" && application.status !== "INTERVIEW_PENDING") {
        throw new AppError("JOIN_APPLICATION_NOT_REVIEWABLE", "该报名当前不可登记面试结果");
      }

      const nextStatus = input.result === "PASSED" ? "INTERVIEW_PASSED" : "INTERVIEW_REJECTED";
      // 首次通过必须明确选择；已通过的重放在上方返回，历史空值不被补写。
      if (input.result === "PASSED") {
        parseMemberDepartment(admittedDepartment, "admittedDepartment");
        await assertNoActiveMemberConflict(tx, application);
      }
      await tx.joinApplicationReview.create({
        data: {
          id: randomUUID(),
          applicationId: application.id,
          result: input.result,
          interviewedAt,
          reviewerUserId: actor.userId!,
          internalNote: cleanOptional(input.internalNote),
          createdAt: new Date(),
        },
      });
      const updated = await tx.joinApplication.update({
        where: { id: application.id },
        data: {
          status: nextStatus,
          admittedDepartment: input.result === "PASSED" ? admittedDepartment : undefined,
          provisionStatus: input.result === "PASSED" ? "PENDING" : "NOT_REQUIRED",
          lastReviewedAt: interviewedAt,
        },
      });
      if (input.result === "PASSED") {
        await tx.accountProvision.create({
          data: {
            id: randomUUID(),
            sourceType: "JOIN_APPLICATION",
            sourceId: application.id,
            idempotencyKey: input.idempotencyKey,
            status: "PENDING",
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        });
      }
      await appendAuditLog(tx, {
        actor,
        actorType: actor.actorType,
        actorUserId: actor.userId,
        action: "join.review.created",
        targetType: "JoinApplication",
        targetId: application.id,
        result: "SUCCESS",
        before: {
          status: application.status,
          provisionStatus: application.provisionStatus,
          admittedDepartment: application.admittedDepartment,
        },
        after: {
          status: nextStatus,
          provisionStatus: updated.provisionStatus,
          admittedDepartment: updated.admittedDepartment,
        },
      });
      // 查重与建档共享事务：并发成员写入会被 Serializable 锁定 / 重试，
      // 冲突或发放失败时审核结论、录取部门、任务及通知全部回滚。
      const provision =
        input.result === "PASSED"
          ? await accountProvisionService.provisionInTransaction(
              tx,
              application.id,
              input.idempotencyKey,
            )
          : null;
      return { application: updated, provision };
    });

    let initializationSecret: string | undefined;
    if (prepared.provision) {
      const result = await accountProvisionService.finishProvision(prepared.provision);
      initializationSecret = result.initializationSecret;
    } else if (input.result === "PASSED" && prepared.application.provisionStatus !== "SUCCEEDED") {
      const provision = await getDb().accountProvision.findUniqueOrThrow({
        where: {
          sourceType_sourceId: {
            sourceType: "JOIN_APPLICATION",
            sourceId: prepared.application.id,
          },
        },
      });
      const result = await accountProvisionService.provisionFromApplication(
        prepared.application.id,
        provision.idempotencyKey,
      );
      initializationSecret = result.initializationSecret;
    }
    const final = await getDb().joinApplication.findUniqueOrThrow({
      where: { id: prepared.application.id },
    });
    return { ...toView(final), ...(initializationSecret ? { initializationSecret } : {}) };
  }

  async softDelete(applicationId: string, actor: AuthorizedActor): Promise<void> {
    requirePermission(actor, "join:review");
    await inSerializableTransaction(async (tx) => {
      // 与审核 / 发放锁同一行；删除不撤销已有成员，也不删除历史任务与审计。
      await tx.$queryRaw`SELECT id FROM join_applications WHERE id = ${applicationId} FOR UPDATE`;
      const application = await tx.joinApplication.findUnique({ where: { id: applicationId } });
      if (!application || application.deletedAt) {
        throw new AppError("RESOURCE_NOT_FOUND", "报名记录不存在");
      }
      const deletedAt = new Date();
      await tx.joinApplication.update({ where: { id: applicationId }, data: { deletedAt } });
      await appendAuditLog(tx, {
        actor,
        actorType: actor.actorType,
        actorUserId: actor.userId,
        action: "join.application.deleted",
        targetType: "JoinApplication",
        targetId: applicationId,
        result: "SUCCESS",
        before: { status: application.status, provisionStatus: application.provisionStatus },
        after: { deletedAt: deletedAt.toISOString() },
      });
    });
  }

  async retryProvision(applicationId: string, actor: AuthorizedActor): Promise<ProvisionView> {
    requirePermission(actor, "member:provision");
    await assertApplicationExists(applicationId);
    const provision = await getDb().accountProvision.findUnique({
      where: { sourceType_sourceId: { sourceType: "JOIN_APPLICATION", sourceId: applicationId } },
    });
    if (!provision || provision.status !== "FAILED") {
      throw new AppError("STATE_TRANSITION_INVALID", "只有失败的发放任务可以重试");
    }
    const result = await accountProvisionService.provisionFromApplication(
      applicationId,
      provision.idempotencyKey,
    );
    await inSerializableTransaction((tx) =>
      appendAuditLog(tx, {
        actor,
        actorType: "USER",
        actorUserId: actor.userId,
        action: "account.provision.retried",
        targetType: "AccountProvision",
        targetId: provision.id,
        result: "SUCCESS",
        after: { status: result.status, attemptCount: result.attemptCount },
      }),
    );
    return result;
  }

  async provision(applicationId: string, actor: AuthorizedActor): Promise<ProvisionView> {
    requirePermission(actor, "member:provision");
    await assertApplicationExists(applicationId);
    const provision = await getDb().accountProvision.findUnique({
      where: { sourceType_sourceId: { sourceType: "JOIN_APPLICATION", sourceId: applicationId } },
    });
    if (!provision) throw new AppError("RESOURCE_NOT_FOUND", "账号发放任务不存在");
    if (provision.status === "FAILED")
      throw new AppError("STATE_TRANSITION_INVALID", "失败任务请使用重试接口");
    return accountProvisionService.provisionFromApplication(
      applicationId,
      provision.idempotencyKey,
    );
  }
}

function validateSubmission(input: SubmitJoinApplicationInput): {
  realName: string;
  studentId: string;
  className: string;
} {
  const fieldErrors: Record<string, string[]> = {};
  if (!input.privacyConsent) fieldErrors.privacyConsent = ["必须确认隐私告知"];
  if (!input.recruitmentCycle.trim() || input.recruitmentCycle.length > 32) {
    fieldErrors.recruitmentCycle = ["招募批次无效"];
  }
  // 姓名：与邀请码注册同一份约束 —— 只去首尾空白，trim 后 2–64 字符，
  // 保留内部字符与空格。
  const realName = trimPersonName(input.realName);
  if (realName === null) fieldErrors.realName = [PERSON_NAME_LENGTH_MESSAGE];
  // 学号 / 班级必填：与邀请码注册同一份约束；不把结果强转成字符串。
  const studentId = trimRequiredTextField(input.studentId, STUDENT_ID_MAX_LENGTH);
  if (studentId === null) fieldErrors.studentId = [STUDENT_ID_LENGTH_MESSAGE];
  const className = trimRequiredTextField(input.className, CLASS_NAME_MAX_LENGTH);
  if (className === null) fieldErrors.className = [CLASS_NAME_LENGTH_MESSAGE];
  if ((input.selfIntroduction?.length ?? 0) > 10_000) fieldErrors.selfIntroduction = ["内容过长"];
  if ((input.preferredDirection?.length ?? 0) > 120) fieldErrors.preferredDirection = ["内容过长"];
  if ((input.applicantRemark?.length ?? 0) > 500) fieldErrors.applicantRemark = ["内容过长"];
  if (Object.keys(fieldErrors).length > 0) {
    throw new AppError("VALIDATION_FAILED", "报名信息未通过校验", { fieldErrors });
  }
  return {
    realName: realName as string,
    studentId: studentId as string,
    className: className as string,
  };
}

async function findDuplicate(cycle: string, qq: string, phone: string) {
  return getDb().joinApplication.findFirst({
    where: {
      recruitmentCycle: cycle,
      OR: [{ qqNormalized: qq }, { phoneNormalized: phone }],
    },
    orderBy: { deletedAt: "desc" },
  });
}

function duplicateReceipt(record: JoinApplication): JoinReceipt {
  if (record.deletedAt) {
    throw new AppError("JOIN_APPLICATION_DUPLICATE", "本批次报名信息已被使用，请联系管理员处理");
  }
  return toReceipt(record, true);
}

async function assertApplicationExists(applicationId: string): Promise<void> {
  const record = await getDb().joinApplication.findFirst({
    where: { id: applicationId, deletedAt: null },
    select: { id: true },
  });
  if (!record) throw new AppError("RESOURCE_NOT_FOUND", "报名记录不存在");
}

function cleanOptional(value?: string): string | undefined {
  const clean = value?.trim();
  return clean || undefined;
}

function toReceipt(record: JoinApplication, duplicate: boolean): JoinReceipt {
  return {
    id: record.id,
    ticketNo: record.ticketNo,
    status: record.status as JoinReceipt["status"],
    submittedAt: record.submittedAt.toISOString(),
    duplicate,
  };
}

function toView(
  record: Pick<
    JoinApplication,
    "id" | "status" | "provisionStatus" | "admittedDepartment" | "lastReviewedAt"
  >,
): JoinApplicationView {
  return {
    id: record.id,
    status: record.status as JoinApplicationView["status"],
    provisionStatus: record.provisionStatus as JoinApplicationView["provisionStatus"],
    admittedDepartment: record.admittedDepartment as JoinApplicationView["admittedDepartment"],
    lastReviewedAt: record.lastReviewedAt?.toISOString() ?? null,
  };
}

function hasPrismaCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export const joinApplicationService = new JoinApplicationService();
