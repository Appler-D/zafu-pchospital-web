import { RepairResult, RepairStatus } from "@/types/contracts";

export const repairCopy = {
  list: {
    title: "维修记录",
    label: "Repair Records",
    lead: "按日期、成员与处理状态快速查找社团的维修记录。草稿和退回记录仅本人及管理员可见。",
    total: "当前结果",
    newAction: "新建记录",
    quickFilters: {
      all: "全部",
      pending: "待审核",
      draft: "草稿",
      rejected: "已退回",
    },
    filters: {
      searchLabel: "搜索维修记录",
      searchPlaceholder: "搜索机主姓名、备注或成员",
      status: "状态",
      category: "分类",
      member: "维修成员",
      result: "维修结果",
      dateFrom: "起始日期",
      dateTo: "结束日期",
      allStatuses: "全部状态",
      allCategories: "全部分类",
      allMembers: "全部成员",
      allResults: "全部结果",
      more: "更多筛选",
      less: "收起筛选",
      difficult: "仅看疑难案例",
      typical: "仅看典型案例",
      submit: "搜索",
      reset: "清除",
    },
    columns: {
      date: "日期",
      category: "分类",
      deviceModel: "机型",
      content: "备注",
      member: "维修成员",
      result: "结果",
      status: "状态",
      action: "操作",
    },
    loading: "正在加载维修记录…",
    loadError: "维修记录加载失败，请稍后重试。",
    reload: "重新加载",
    uncategorized: "未分类",
    missingContent: "尚未填写备注",
    missingDate: "日期待填",
    missingDeviceModel: "—",
    missingResult: "结果待填",
    difficult: "疑难",
    typical: "典型",
    view: "查看",
    previousPage: "上一页",
    nextPage: "下一页",
  },
  create: {
    title: "新建维修记录",
    label: "New Repair",
    lead: "直接填写维修信息并上传照片，提交后进入审核。",
  },
  edit: {
    title: "编辑维修记录",
    label: "Edit Repair",
    lead: "保存草稿不会进入统计；提交后等待管理员审核。",
  },
  detail: {
    title: "维修记录详情",
    label: "Repair Detail",
    lead: "查看维修信息、审核历史与记录时间线。",
  },
  empty: "暂时没有符合条件的维修记录。",
} as const;
export const repairStatusLabels: Record<(typeof RepairStatus)[number], string> = {
  DRAFT: "草稿",
  PENDING: "待审核",
  APPROVED: "已通过",
  REJECTED: "已退回",
};
/** 已撤回审核的草稿（DRAFT 且曾经提交过，issue #165）：与未填完的草稿区分。 */
export const repairWithdrawnLabel = "已撤回";
export const repairDetailCopy = {
  withdraw: "撤回审核",
  withdrawing: "撤回中…",
  withdrawConfirmTitle: "确认撤回审核？",
  withdrawConfirmHint:
    "撤回后记录回到草稿，可修改后重新提交；这次操作会保留在时间线与审计记录里。已通过或已退回的记录不在此处理。",
  withdrawConfirm: "确认撤回",
  withdrawCancel: "取消",
  withdrawSuccess: "已撤回，记录回到草稿。",
  withdrawFailed: "撤回失败，请稍后重试",
  withdrawInvalidResponse: "服务返回了无法解析的响应",
  withdrawNetworkError: "网络异常，请检查连接后重试",
  withdrawnNotice: "这条记录已从审核中撤回，修改后可重新提交。",
} as const;
export const repairResultLabels: Record<(typeof RepairResult)[number], string> = {
  COMPLETED: "已完成",
  NOT_COMPLETED: "未完成",
};
/**
 * 维修记录字段的硬限制。
 *
 * 服务端校验与表单 HTML 属性共用这一组数值 —— 两边各写一份是「限制看着有、实际没生效」
 * 的常见来源（issue #62 后端3）。
 */
export const repairFieldLimits = {
  contentMaxLength: 10000,
  remarkMaxLength: 2000,
  /** 机主姓名上限，与 `owner_name` 的 VarChar(40) 对齐。 */
  ownerNameMaxLength: 40,
  durationMinutesMin: 1,
  durationMinutesMax: 10080,
  /** 维修日期下限：早于它的基本是年份打错（1026 年、202 年这类）。 */
  repairDateMin: "2020-01-01",
  /** 参与维修人员总数上限（含创建人本人，issue #114）。 */
  participantMaxCount: 9,
} as const;
export const repairEditorCopy = {
  activitySubmitSuccess: "提交成功，一秒后返回活动页面。",
  requiredMark: "必填",
  /** 参与维修人员区块（issue #114）：时长不分人，对全部参与者生效。 */
  participantsLabel: "参与维修人员",
  participantsCreatorTag: "创建人",
  participantsHint:
    "创建人固定保留；可添加其他参与成员，误添加的可移除。维修时长对全部参与者生效。",
  participantsAddLabel: "输入姓名添加协作者",
  participantsAddPlaceholder: "输入姓名，选择匹配成员…",
  participantsMatches: "找到 {count} 位成员，选择即可添加",
  participantsNoMatches: "未找到匹配成员，请尝试其他姓名",
  participantsNoOptions: "暂无可添加的成员",
  participantsRemove: "移除",
  participantsRemoveLabel: "移除参与成员 {name}",
  participantsCount: "已选 {count} / {limit} 人",
  participantsLimit: "已到达上限",
  /** 表单是「先存草稿、再提交」两步，必填只针对提交那一刻。 */
  requiredNote: "标注「必填」的字段在提交审核前必须填齐；草稿可以先保存。",
  /** 新建流程没有草稿（issue #72），提示改说提交口径。 */
  requiredNoteCreate: "标注「必填」的字段都已必填；填写完成后点「提交审核」进入管理员审核。",
  dateHint: "默认今天；不得晚于今天。",
  ownerNameLabel: "机主姓名",
  ownerNameHint: "机主即送修设备的同学；请填写真实姓名，便于核对与回访。",
  ownerPhoneLabel: "机主电话",
  ownerPhoneHint: "11 位中国大陆手机号；完整号码仅本人与审核管理员可见。",
  durationHint: `按实际耗时填写整数分钟，${repairFieldLimits.durationMinutesMin}–${repairFieldLimits.durationMinutesMax} 分钟；提交审核必填。`,
  remarkLabel: "备注",
  remarkHint: `选填，最多 ${repairFieldLimits.remarkMaxLength} 字。备注会展示在案例库摘要中，请勿填写机主电话等敏感信息。`,
  /** 「备注 + 照片」合并块：照片从提交必填降级为选填附件（issue #79 第 6 项）。 */
  attachmentsTitle: "备注与附件",
  /** 照片上限来自服务端（随详情下发），所以文案留占位符而不是写死数字。 */
  photoHint: "支持 JPEG、PNG、WebP；单张不超过 {size}、最多 {count} 张。选填，可稍后补充。",
  /** 新建页尚未建档：上限由服务端校验；首次选图会把当前内容存成草稿并进入编辑页（issue #162）。 */
  photoHintCreate:
    "支持 JPEG、PNG、WebP；首次选择照片会先把当前内容存为草稿并进入编辑页，大小与数量上限由服务端校验。",
  /** 新建页从 sessionStorage 恢复未提交内容时的提示（issue #162）。 */
  createDraftRestored: "已恢复上次未提交的内容；提交成功后会清除这份本地暂存。",
  photoTooLarge: "「{name}」有 {size}，超过单张 {limit} 的上限，请压缩或换一张。",
  photoTooMany: "已上传 {count} 张，最多只能再传 {remain} 张。",
};
/** 照片体积的可读写法：提示文案与服务端报错共用，避免两处各写一份换算。 */
export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${Number(mb.toFixed(mb >= 10 ? 0 : 1))} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}
/**
 * 参与维修人员的展示名（issue #114）：全部参与者「、」连接；创建人恒在首位（服务端保证）。
 * 列表、详情、案例卡共用一处写法；参与行缺失（理论不可能）时回退创建人本人。
 */
export function formatRepairParticipants(record: {
  member: { id: string; name: string };
  participants: Array<{ id: string; name: string }>;
}): string {
  return record.participants.length
    ? record.participants.map((participant) => participant.name).join("、")
    : record.member.name;
}
/** 成员端不填写维修结果，缺省按「已完成」记录；管理员仍可在管理端改成「未完成」。 */
export const defaultRepairResult: RepairResult = "COMPLETED";
export const repairTimelineLabels = {
  CREATED: "创建草稿",
  UPDATED: "修改记录",
  PHOTO_ADDED: "添加照片",
  PHOTO_REMOVED: "移除照片",
  SUBMITTED: "提交审核",
  RESUBMITTED: "重新提交",
  WITHDRAWN: "撤回审核",
  APPROVED: "审核通过",
  REJECTED: "审核退回",
  DELETED: "软删除",
  FLAG_CHANGED: "标记变化",
} as const;
