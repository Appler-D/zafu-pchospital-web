import type { RepairMemberOption } from "@/types/contracts";

/** 参与成员候选搜索：展示名、姓名、昵称任一包含关键字即命中。 */
export function matchesRepairMemberKeyword(member: RepairMemberOption, keyword: string): boolean {
  const needle = keyword.trim().toLocaleLowerCase();
  if (!needle) return false;
  return [member.name, member.realName, member.nickname].some((value) =>
    value?.toLocaleLowerCase().includes(needle),
  );
}
