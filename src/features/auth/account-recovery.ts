import type { AdminAccountLookupResult } from "@/types/contracts";

/**
 * 账号恢复资格判定（抽出的公共口径， 邮箱找回复用）：
 * 与登录的 `readPrincipal` 守卫同义 ——「恢复出来能登进来」才允许恢复。
 *
 * - `SELF`：管理员不能给自己签临时密码（自助恢复例外）。为 `null` / `undefined`
 *   时不检查自己（邮箱自助找回发起人本来就是要恢复的那位用户，不存在「自我恢复」问题）；
 * - `DISABLED`：账号软删 / 非 ACTIVE；
 * - `MEMBER_INACTIVE`：成员身份已撤且无 ADMIN 角色，重置也登不进来。
 */
export type AccountRecoveryTarget = {
  id: string;
  deletedAt: Date | null;
  status: string;
  memberProfile: { deletedAt: Date | null; status: string } | null;
  roles: { role: { code: string } }[];
};

export type AccountBlockedReason = AdminAccountLookupResult["blockedReason"];

export function resolveAccountBlockedReason(
  user: AccountRecoveryTarget,
  actorUserId: string | null | undefined,
): AccountBlockedReason {
  // `null`（自助找回）与 `undefined`（无主体身份）都不做「自我恢复」判定 ——
  // 与原实现 `user.id === actor.userId` 的直接比较语义一致。
  if (actorUserId != null && user.id === actorUserId) return "SELF";
  if (user.deletedAt || user.status !== "ACTIVE") return "DISABLED";
  const codes = user.roles.map((entry) => entry.role.code);
  const activeMember =
    user.memberProfile &&
    !user.memberProfile.deletedAt &&
    user.memberProfile.status === "ACTIVE" &&
    codes.includes("MEMBER");
  if (!codes.includes("ADMIN") && (user.memberProfile ? !activeMember : codes.includes("MEMBER")))
    return "MEMBER_INACTIVE";
  return null;
}
