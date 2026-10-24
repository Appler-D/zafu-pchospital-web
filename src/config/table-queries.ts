import {
  adminCopy,
  memberStatusLabels,
  memberRoleLabels,
  joinApplicationStatusLabels,
  provisionStatusLabels,
  inviteCodeStatusLabels,
} from "@/config/admin";
import { memberDepartmentLabels } from "@/config/member-department";
import { repairStatusLabels, repairResultLabels } from "@/config/repairs";
import { MEMBER_FILTERABLE } from "@/features/members/member-filter-fields";
import { MEMBER_SORTABLE } from "@/features/members/member-sort";
import { REPAIR_SORTABLE } from "@/features/repairs/repair-sort";
import {
  JOIN_FILTERABLE,
  JOIN_SORTABLE,
  INVITE_FILTERABLE,
  INVITE_SORTABLE,
  AUDIT_FILTERABLE,
  AUDIT_SORTABLE,
  REPAIR_FILTERABLE,
  TABLE_GROUPS,
} from "@/features/admin/table-fields";
import type { FilterableFields } from "@/lib/api/list-filter";
import type { FilterFieldOption } from "@/lib/table/field-spec";

export type TableId = keyof typeof TABLE_GROUPS;
type Field = {
  label: string;
  sortLabel?: string;
  sortDescription?: string;
  kind?: "date" | "number";
  labels?: Readonly<Record<string, string>>;
};
const fields: Record<string, Field> = {
  realName: { label: "姓名" },
  nickname: { label: "昵称" },
  studentId: { label: "学号" },
  className: { label: "班级" },
  joinedAt: { label: "加入时间", kind: "date" },
  department: { label: "部门", labels: memberDepartmentLabels },
  repairDate: { label: "维修日期", kind: "date" },
  durationMinutes: { label: "维修时长（分钟）", kind: "number" },
  memberName: {
    label: "参与成员姓名",
    sortLabel: "创建成员实名",
    sortDescription: "按创建成员实名排序；此列显示全部参与者",
  },
  categoryName: { label: "故障分类" },
  deviceModel: { label: "设备型号" },
  createdAt: { label: "创建时间", kind: "date" },
  ticketNo: { label: "报名编号" },
  recruitmentCycle: { label: "招募批次" },
  submittedAt: { label: "提交时间", kind: "date" },
  lastReviewedAt: { label: "面试时间", kind: "date" },
  approvedAt: { label: "通过时间", kind: "date" },
  provisionStatus: { label: "账号发放", labels: provisionStatusLabels },
  displayPrefix: { label: "邀请码前缀" },
  activeFrom: { label: "生效时间", kind: "date" },
  expiresAt: { label: "失效时间", kind: "date" },
  maxUses: { label: "使用上限", kind: "number" },
  usedCount: { label: "已使用次数", kind: "number" },
  action: { label: "操作动作" },
  actorType: { label: "操作人类型", labels: { USER: "用户", SYSTEM: "系统" } },
  actorUserId: { label: "操作人 ID" },
  targetType: { label: "目标类型" },
  targetId: { label: "目标 ID" },
  requestId: { label: "请求编号" },
  errorCode: { label: "错误码" },
  isDifficult: { label: "疑难案例", labels: { true: "是", false: "否" } },
  isTypical: { label: "典型案例", labels: { true: "是", false: "否" } },
};
const policies: Record<
  TableId,
  {
    sortable: readonly string[];
    filterable: FilterableFields;
    labels: Readonly<Record<string, Readonly<Record<string, string>>>>;
  }
> = {
  members: {
    sortable: MEMBER_SORTABLE,
    filterable: MEMBER_FILTERABLE,
    labels: { status: memberStatusLabels, role: memberRoleLabels },
  },
  repairs: {
    sortable: REPAIR_SORTABLE,
    filterable: REPAIR_FILTERABLE,
    labels: { status: repairStatusLabels, result: repairResultLabels },
  },
  "join-applications": {
    sortable: JOIN_SORTABLE,
    filterable: JOIN_FILTERABLE,
    labels: { status: joinApplicationStatusLabels },
  },
  "invite-codes": {
    sortable: INVITE_SORTABLE,
    filterable: INVITE_FILTERABLE,
    labels: { status: inviteCodeStatusLabels },
  },
  audit: {
    sortable: AUDIT_SORTABLE,
    filterable: AUDIT_FILTERABLE,
    labels: { result: adminCopy.audit.resultLabels },
  },
};
export function tableField(id: TableId, key: string): Field {
  return {
    ...fields[key],
    label:
      fields[key]?.label ??
      (key === "status"
        ? "状态"
        : key === "result"
          ? "结果"
          : key === "query"
            ? "关键词"
            : key === "role"
              ? "角色"
              : key),
    labels: policies[id].labels[key] ?? fields[key]?.labels,
  };
}
export function tableSortLabel(id: TableId, key: string): string {
  const field = tableField(id, key);
  return field.sortLabel ?? field.label;
}

export function tableQueryOptions(id: TableId) {
  const policy = policies[id];
  const filters: FilterFieldOption[] = Object.entries(policy.filterable).map(([key, ops]) => {
    const field = tableField(id, key);
    return {
      key,
      columnKey: key,
      label: field.label,
      ops,
      input: field.labels
        ? {
            kind: "enum",
            options: Object.entries(field.labels).map(([value, label]) => ({ value, label })),
          }
        : field.kind === "date"
          ? { kind: "date" }
          : field.kind === "number"
            ? { kind: "number" }
            : { kind: "text" },
    };
  });
  return { ...policy, id, filters, groups: TABLE_GROUPS[id] as readonly string[] };
}
export type TableQueryOptions = ReturnType<typeof tableQueryOptions>;
