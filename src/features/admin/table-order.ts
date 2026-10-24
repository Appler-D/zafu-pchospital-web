import type { Prisma } from "@/generated/prisma/client";
import { tableOrderBy } from "@/lib/table/order-by";
import type { SortRule } from "@/types/table";
import { AUDIT_SORTABLE, INVITE_SORTABLE } from "./table-fields";

export function auditOrderBy(sort?: SortRule[]) {
  return tableOrderBy<Prisma.AuditLogOrderByWithRelationInput>(
    sort,
    Object.fromEntries(
      AUDIT_SORTABLE.map((field) => [
        field,
        (direction: SortRule["direction"]) => ({ [field]: direction }),
      ]),
    ),
    [{ createdAt: "desc" }, { id: "desc" }],
    { id: "desc" },
  );
}
export function inviteOrderBy(sort?: SortRule[]) {
  return tableOrderBy<Prisma.InviteCodeOrderByWithRelationInput>(
    sort,
    Object.fromEntries(
      INVITE_SORTABLE.map((field) => [
        field,
        (direction: SortRule["direction"]) => ({ [field]: direction }),
      ]),
    ),
    [{ createdAt: "desc" }, { id: "desc" }],
    { id: "desc" },
  );
}
