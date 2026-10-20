import { MemberDepartment } from "@/types/contracts";

export const memberDepartmentLabels: Record<MemberDepartment, string> = {
  REPAIR: "维修部",
  PUBLICITY: "宣传部",
  OFFICE: "办公室",
};

export const memberDepartmentOptions = MemberDepartment.map((value) => ({
  value,
  label: memberDepartmentLabels[value],
}));
