import { AppError } from "@/lib/api/errors";
import { MemberDepartment } from "@/types/contracts";

/** HTTP 和 Service 共用：不接受空值、中文标签或隐式字符串转换。 */
export function parseMemberDepartment(value: unknown, field = "department"): MemberDepartment {
  if (typeof value !== "string" || !MemberDepartment.includes(value as MemberDepartment)) {
    throw new AppError("VALIDATION_FAILED", "请选择有效部门", {
      fieldErrors: { [field]: ["请选择维修部、宣传部或办公室"] },
    });
  }
  return value as MemberDepartment;
}
