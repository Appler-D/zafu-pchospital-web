import type { JoinApplication, Prisma } from "@/generated/prisma/client";
import { AppError } from "@/lib/api/errors";
import { normalizeEmail, normalizePhone, normalizeQq } from "@/lib/security/normalization";

/** 仅首次通过时检查；调用方的 Serializable 事务必须同时完成建档。 */
export async function assertNoActiveMemberConflict(
  tx: Prisma.TransactionClient,
  application: JoinApplication,
): Promise<void> {
  const studentId = application.studentId?.trim() || undefined;
  const identities = [
    { type: "QQ", identifierNormalized: normalizeQq(application.qqNormalized) },
    { type: "PHONE", identifierNormalized: normalizePhone(application.phoneNormalized) },
    ...(application.email?.trim()
      ? [{ type: "EMAIL", identifierNormalized: normalizeEmail(application.email) }]
      : []),
  ];
  const matches = await tx.memberProfile.findMany({
    where: {
      status: "ACTIVE",
      deletedAt: null,
      user: {
        status: "ACTIVE",
        deletedAt: null,
        roles: { some: { revokedAt: null, role: { code: "MEMBER" } } },
      },
      OR: [
        ...(studentId ? [{ studentId }] : []),
        { user: { identities: { some: { deletedAt: null, OR: identities } } } },
      ],
    },
    select: {
      studentId: true,
      user: {
        select: {
          identities: {
            where: { deletedAt: null, OR: identities },
            select: { type: true },
          },
        },
      },
    },
  });
  const fields = new Set<string>();
  for (const match of matches) {
    if (studentId && match.studentId?.trim() === studentId) fields.add("学号");
    for (const identity of match.user.identities) {
      if (identity.type === "QQ") fields.add("QQ 号");
      if (identity.type === "PHONE") fields.add("手机号");
      if (identity.type === "EMAIL") fields.add("邮箱");
    }
  }
  if (fields.size) {
    throw new AppError(
      "ACCOUNT_IDENTITY_CONFLICT",
      `${[...fields].join("、")}与已有成员重复，不能通过。请联系报名者重新报名或更正已有的错误账号。`,
    );
  }
}
