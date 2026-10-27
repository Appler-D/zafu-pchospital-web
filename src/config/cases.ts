/** 已通过且标记为典型或疑难的维修案例文案。 */

import { communityCopy } from "@/config/community";

export const casesCopy = {
  title: "案例库",
  label: "Case Library",

  lead: "已通过审核的典型与疑难维修案例",

  scopeLabel: "案例范围",
  scope: {
    all: "全部已标记",
    typical: communityCopy.flags.typical,
    difficult: communityCopy.flags.difficult,
  },

  filtersLabel: "搜索与筛选案例",
  filters: {
    searchLabel: "关键词",
    searchPlaceholder: "搜索故障现象或处理过程",
    category: "故障分类",
    allCategories: "全部分类",
    submit: "搜索",
    reset: "清除",
  },

  /** 当前结果条数，`{count}` 由组件替换。 */
  total: "共 {count} 条",
  loading: "正在加载案例…",
  loadError: "案例加载失败，请稍后重试",
  reload: "重新加载",
  /** 筛选后无结果与案例库本身为空分开说：后者才说明全站没有被标记的已通过记录。 */
  emptyFiltered: "没有符合条件的案例，换个分类或关键词试试",
  empty: "案例库还是空的 —— 目前还没有被标记为典型案例或疑难案例的维修记录",

  /** 卡片字段缺失时的占位 */
  uncategorized: "未分类",
  missingContent: "尚未填写备注",
  durationLabel: "耗时",

  detailAction: "查看详情",
  paginationLabel: "案例分页",
  previousPage: "上一页",
  nextPage: "下一页",
} as const;
