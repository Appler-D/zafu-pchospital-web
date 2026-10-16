import type { RoleCode } from "@/types/contracts";

/** 角色默认落点：只有 ADMIN、没有成员档案的账号也必须回到 /admin，不能固定 /member。 */
export function loginDestination(principal: {
  mustChangePassword: boolean;
  roles: readonly RoleCode[];
}): string {
  if (principal.mustChangePassword) return "/account/change-password";
  return principal.roles.includes("ADMIN") ? "/admin" : "/member";
}
