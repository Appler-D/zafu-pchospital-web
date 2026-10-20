import assert from "node:assert/strict";
import test from "node:test";

import { memberDepartmentOptions } from "../../src/config/member-department";
import { parseMemberDepartment } from "../../src/features/members/member-department";
import { updateProfileInput } from "../../src/features/member-profile/member-profile-http";
import { AppError } from "../../src/lib/api/errors";
import { MemberDepartment } from "../../src/types/contracts";

test("三个部门代码有效，标签固定；拒绝空值、中文、数组和隐式转换", () => {
  assert.deepEqual(
    memberDepartmentOptions.map((item) => item.label),
    ["维修部", "宣传部", "办公室"],
  );
  for (const code of MemberDepartment) assert.equal(parseMemberDepartment(code), code);
  for (const value of [undefined, null, "", "维修部", "repair", " REPAIR ", ["REPAIR"], {}, 1]) {
    assert.throws(
      () => parseMemberDepartment(value, "admittedDepartment"),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === "VALIDATION_FAILED" &&
        !!error.fieldErrors?.admittedDepartment,
    );
  }
});

test("成员自助资料拒绝部门字段", () => {
  assert.throws(
    () => updateProfileInput({ version: 1, department: "OFFICE" }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === "VALIDATION_FAILED" &&
      !!error.fieldErrors?.department,
  );
});
