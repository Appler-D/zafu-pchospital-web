import { readFile, writeFile } from "node:fs/promises";
import { tableQueryOptions, tableField, type TableId } from "../src/config/table-queries";

import * as React from "react";
import { format } from "prettier";
(globalThis as unknown as { React: typeof React }).React = React;

async function main() {
  const { memberTableSpec } = await import("../src/components/admin/member-table-spec");
  const { repairTableSpec } = await import("../src/components/admin/repair-table-spec");
  const { joinApplicationTableSpec } =
    await import("../src/components/admin/join-application-table-spec");
  const { inviteCodeTableSpec } = await import("../src/components/admin/invite-code-table-spec");
  const { auditTableSpec } = await import("../src/components/admin/audit-table-spec");
  const { categoryTableSpec } = await import("../src/components/admin/category-table-spec");
  const { skillTableSpec } = await import("../src/components/admin/skill-table-spec");
  const specs = [
    memberTableSpec,
    repairTableSpec,
    joinApplicationTableSpec,
    inviteCodeTableSpec,
    auditTableSpec,
    categoryTableSpec,
    skillTableSpec,
  ];
  const queryIds = ["members", "repairs", "join-applications", "invite-codes", "audit"];
  const notes: Record<string, string> = {
    contacts: "脱敏复合联系方式；仅沿用原关键词查询，不新增身份排序或分组。",
    binding: "绑定 QQ/手机号为脱敏复合值；沿用原精确查询，不新增披露。",
    roles: "多值角色保留快捷 role 筛选，不按关联集合排序/分组。",
    skills: "多值标签；不展开跨表排序/分组。",
    repairs: "跨表维修计数/时长，保留原展示；不新增全量聚合排序。",
    actor: "昵称/实名/账号名回退的派生展示；高级条件按操作人 ID 或类型筛选。",
    window: "复合区间；高级面板分别按生效时间、失效时间查询。",
    usage: "复合次数；高级面板分别按已用次数、使用上限查询。",
    realName: "按成员实名排序和筛选；昵称可独立查询。",
    memberName: "显示全部参与者（昵称优先）；按创建成员实名排序，按任一参与者实名或昵称筛选。",
    approvedAt: "首次 PASSED 审核记录 createdAt 的最小值，历史缺失为 null；不等同面试时间。",
    lastReviewedAt: "管理员填写的面试时间，沿用原 lastReviewedAt；非服务端通过操作时间。",
    actions: "操作列，不是数据字段。",
    select: "选择控件，不是数据字段。",
  };
  let text = `# 表格能力清单\n\n<!-- generated: pnpm exec tsx tools/generate-table-capabilities.ts -->\n\n本文件由表格 spec 和共用查询白名单生成。修改来源后运行生成命令；\n\`pnpm table:capabilities\` 检查漂移，CI 必须通过此闸门。\n\n## 通用规则\n\n- 五张分页表均由服务端排序/筛选，不只处理当前页。列头三态，最多 3 项排序，最终以 id desc 兜底；不排序时恢复各表原默认序。枚举按存储码排序；可空字段沿用 GreatSQL 的 ASC 空值在前、DESC 在后。\n- 关键词/快捷条件/最多 5 条列级条件同时以 AND 生效；日期按上海自然日含结束日，维修 DATE 列保持日历日口径。筛选或排序变化重新加载第 1 页，保留已渲染内容直到响应到达。\n- 默认计数复用 meta.pagination.total，为当前筛选后的全量，不是当前已加载数；分组只支持下列枚举，按需随同一列表 HTTP 响应返回 meta.summary。邀请码派生状态按同一服务端 now 串行计数，不另开一组并发请求。无求和/耗时/统计结果导出。\n- 每次 20 条，服务端上限仍为 100；沿用连续加载和“已加载/总数”，不改成另一套翻页。输入仅在应用时发请求，不逐字查询；旧条件请求取消，迟到结果丢弃。\n- 清除同时恢复关键词、快捷条件、列级条件、排序与分组；列宽偏好用高级面板独立恢复。分类/技能无查询条件，清除入口禁用并说明，拖动序不被重置。\n- URL 仅恢复受控排序、日期与枚举条件；姓名、QQ、手机号、学号、批次等文本不写页面 URL/持久存储。刷新/回退恢复可分享部分，连续加载从第一页重新读取。\n- 成员、维修和报名导出复用列表筛选与排序，覆盖全部匹配记录；超限拒绝，不静默截断。维修/报名保留原列及权限/审计；成员导出同时要求 member:manage 与 data:export，QQ/手机号脱敏且不导出邮箱。文本条件值不进入新增审计摘要。\n\n`;
  for (const spec of specs) {
    const options = queryIds.includes(spec.id) ? tableQueryOptions(spec.id as TableId) : undefined;
    text += `## ${spec.title}（${spec.id}）\n\n| 字段/列 | 排序 | 筛选 | 分组计数 | 说明 |\n| --- | --- | --- | --- | --- |\n`;
    const seen = new Set<string>();
    for (const field of spec.fields) {
      const key = field.sortKey ?? field.key;
      seen.add(key);
      const sortable = Boolean(options?.sortable.includes(key) && field.sortable !== false);
      const filters = options?.filterable[key];
      const group = options?.groups.includes(key);
      text += `| ${field.label || field.headLabel || field.key}（${key}） | ${sortable ? "升/降" : "—"} | ${filters?.join(" / ") ?? "—"} | ${group ? "支持" : "—"} | ${options ? (notes[key] ?? notes[field.key] ?? (sortable || filters ? "标量查询；不对该字段另做聚合。" : "派生/复合列，不提供独立查询。")) : "业务拖动序优先；保留原编辑/启停与引用计数，不提供列头排序、筛选或分组。"} |\n`;
    }
    for (const key of new Set([
      ...(options?.sortable ?? []),
      ...Object.keys(options?.filterable ?? {}),
      ...(options?.groups ?? []),
    ])) {
      if (seen.has(key) || !options) continue;
      text += `| 高级面板：${tableField(options.id, key).label}（${key}） | ${options.sortable.includes(key) ? "升/降" : "—"} | ${options.filterable[key]?.join(" / ") ?? "—"} | ${options.groups.includes(key) ? "支持" : "—"} | 分开查询复合列中的标量；分组仅在抽屉显示。 |\n`;
    }
    text += "\n";
  }
  text += `## 专用视图边界\n\n- 活动管理/接待看板：保留原拖动、状态、出勤与队列规则；本轮不改成分页内核表。\n- 成员详情、通知、账号邮箱、导出面板等内嵌只读/任务表：保留专用交互和权限，不承诺独立排序/分组。\n- 不读取更多个人资料用于统计，不改变 Session、邮箱门禁、审核/建档及任何写操作。\n`;
  const file = new URL("../docs/table-capabilities.md", import.meta.url);
  text = await format(text, { parser: "markdown" });
  if (process.argv.includes("--check")) {
    if ((await readFile(file, "utf8")) !== text) throw new Error("表格能力清单漂移，请重新生成");
    console.log("表格能力清单一致");
  } else await writeFile(file, text, "utf8");
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "生成失败");
  process.exitCode = 1;
});
