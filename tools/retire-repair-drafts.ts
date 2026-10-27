import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  type DraftRetirementReport,
  type DraftRetirementWithdrawnMode,
} from "../src/features/repairs/repair-draft-retirement";
import {
  databaseLabel,
  retireRepairDrafts,
  type DraftRetirementApplyResult,
  type DraftRetirementSnapshot,
} from "../src/features/repairs/repair-draft-retirement-service";
import { disconnectDb } from "../src/lib/db/client";

/**
 * 维修草稿下线：生产存量 DRAFT 盘点与处置。
 *
 * 用法：
 *   corepack pnpm retire:repair-drafts
 *   corepack pnpm retire:repair-drafts --submitted=void [--json=<报告路径>]
 *   corepack pnpm retire:repair-drafts --apply --backup-dir=<备份目录> \
 *     --expect-db=zafu_pchospital [--submitted=void|submit]
 *
 * - 缺省 dry-run：只读盘点，按来源 / 字段完整度 / 处置结果分组，不写库；
 * - `--apply` 必须同时给出备份目录与目标库名，备份成功后才会写库；
 * - 已撤回草稿（`submittedAt` 非空）不会自动处置，apply 时用 `--submitted` 明确选择；
 * - 每条记录单独事务、`version` 乐观锁；失败项留在报告里，重跑只处理剩余草稿；
 * - 作废只做软删除并清空接待关联，不物理删除；审计 / 时间线标 `draft-retire`。
 */

type CliOptions = {
  apply: boolean;
  backupDir: string | null;
  submittedMode: DraftRetirementWithdrawnMode | null;
  expectDb: string | null;
  jsonPath: string | null;
};

function main(): Promise<void> {
  return run();
}

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.apply) assertExpectedDatabase(options.expectDb!);

  const result = await retireRepairDrafts({
    apply: options.apply,
    withdrawnMode: options.submittedMode,
    backupWriter: options.apply
      ? (snapshot, report, meta) => writeBackup(options.backupDir!, snapshot, report, meta)
      : undefined,
  });

  printReport(result.report, options);
  const publicResult = {
    kind: options.apply ? "repair-draft-retirement-result" : "repair-draft-retirement-report",
    database: databaseLabel(),
    exportedAt: new Date().toISOString(),
    report: publicReport(result.report),
    ...(result.applied ? { applied: result.applied } : {}),
  };
  if (options.jsonPath) await writeJson(options.jsonPath, publicResult);

  if (!result.applied) {
    if (result.report.withdrawn.total > 0 && options.submittedMode === null)
      console.log(
        "\n注意：存在已撤回草稿；apply 前请用 --submitted=void 或 --submitted=submit 明确口径。",
      );
    console.log("\ndry-run 完成，未写库。确认报告后再加 --apply 执行。");
    return;
  }

  printApplyResult(result.applied);
  const resultLogPath = await writeResultLog(
    options.backupDir!,
    result.applied.runId,
    publicResult,
  );
  console.log(`执行日志：${resultLogPath}`);
  if (!result.applied.postCheckPassed) process.exitCode = 1;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    apply: false,
    backupDir: null,
    submittedMode: null,
    expectDb: null,
    jsonPath: null,
  };
  for (const arg of args) {
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    const value = readArgValue(arg, "--backup-dir");
    if (value !== null) {
      options.backupDir = value;
      continue;
    }
    const submitted = readArgValue(arg, "--submitted");
    if (submitted !== null) {
      if (submitted !== "void" && submitted !== "submit")
        throw new Error("--submitted 只接受 void 或 submit");
      options.submittedMode = submitted;
      continue;
    }
    const expectDb = readArgValue(arg, "--expect-db");
    if (expectDb !== null) {
      options.expectDb = expectDb;
      continue;
    }
    const jsonPath = readArgValue(arg, "--json");
    if (jsonPath !== null) {
      options.jsonPath = jsonPath;
      continue;
    }
    throw new Error(`未知参数：${arg}（--help 查看用法）`);
  }
  if (options.apply && !options.backupDir)
    throw new Error("--apply 必须同时提供 --backup-dir=<目录>");
  if (options.apply && !options.expectDb)
    throw new Error("--apply 必须用 --expect-db=<库名> 确认目标数据库");
  return options;
}

function readArgValue(arg: string, name: string): string | null {
  const prefix = `${name}=`;
  if (!arg.startsWith(prefix)) return null;
  const value = arg.slice(prefix.length).trim();
  if (!value) throw new Error(`${name} 不能为空`);
  return value;
}

function assertExpectedDatabase(expected: string): void {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("未设置 DATABASE_URL");
  const actualName = new URL(raw).pathname.replace(/^\/+/, "");
  const actualLabel = databaseLabel();
  // 允许只核对库名（防最常见误连），也允许写 host:port/库名 同时防同名库。
  const matched = expected.includes("/") ? expected === actualLabel : expected === actualName;
  if (!matched)
    throw new Error(
      `目标库不匹配：当前为「${actualLabel}」，--expect-db 为「${expected}」。已拒绝执行。`,
    );
}

function printUsage(): void {
  console.log(`维修草稿下线：盘点与处置（issue #223）

用法：
  pnpm retire:repair-drafts [--submitted=void|submit] [--json=<报告路径>]
  pnpm retire:repair-drafts --apply --backup-dir=<备份目录> --expect-db=<库名> \\
    [--submitted=void|submit] [--json=<结果路径>]

说明：
  - 缺省 dry-run，只读；--apply 才会写库，且必须先写出备份。
  - --expect-db 可写库名（只防库名误连）或完整 host:port/库名（同时防同名库）。
  - 已撤回草稿需用 --submitted 明确按作废（void）或补提（submit）处置。
  - 作废为软删除，并清空活动接待的 repair_record_id；不物理删除。`);
}

async function writeBackup(
  backupDir: string,
  snapshot: DraftRetirementSnapshot,
  report: DraftRetirementReport,
  meta: { runId: string; startedAt: string },
): Promise<string> {
  await mkdir(backupDir, { recursive: true });
  const path = resolve(join(backupDir, `${meta.runId}.backup.json`));
  await writeJson(path, {
    kind: "repair-draft-retirement-backup",
    runId: meta.runId,
    startedAt: meta.startedAt,
    database: snapshot.database,
    summary: publicReport(report),
    snapshot,
  });
  return path;
}

async function writeResultLog(backupDir: string, runId: string, result: unknown): Promise<string> {
  const path = resolve(join(backupDir, `${runId}.result.json`));
  await writeJson(path, result);
  return path;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // 备份含机主姓名 / 电话，只留在服务器私有目录。
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function publicReport(report: DraftRetirementReport) {
  return {
    ...report,
    items: report.items.map((item) => ({ ...item, patch: undefined })),
  };
}

function printReport(report: DraftRetirementReport, options: CliOptions): void {
  console.log(`数据库：${databaseLabel()}`);
  console.log(`模式：${options.apply ? "apply（写库）" : "dry-run（未写库）"}`);
  console.log(`存量草稿：${report.total}`);
  console.log(
    `处置：补提 ${report.byAction.submit} / 作废 ${report.byAction.void} / 撤回待定 ${report.byAction["withdrawn-pending"]}`,
  );
  console.log(
    `来源：活动接待 ${sourceCounts(report.bySource.activity)}；旧活动键 ${sourceCounts(report.bySource["legacy-activity"])}；手工/其他 ${sourceCounts(report.bySource.manual)}`,
  );
  printCounts("字段缺失（补全前）", report.byMissingField, FIELD_LABELS);
  printCounts("实际补全字段", report.byBackfilledField, FIELD_LABELS);
  printCounts("不可补提 / 作废原因", report.byVoidReason, VOID_REASON_LABELS);
  console.log(
    `已撤回：${report.withdrawn.total}（可补提 ${report.withdrawn.eligibleToSubmit} / 不可补提 ${report.withdrawn.ineligible}；当前策略：${report.withdrawn.mode ?? "未指定"}）`,
  );
  if (report.items.length) {
    console.log("\n明细（不输出姓名 / 电话）：");
    for (const item of report.items) printItem(item);
  }
}

function sourceCounts(counts: DraftRetirementReport["bySource"]["activity"]): string {
  return `${counts.submit + counts.void + counts["withdrawn-pending"]}（补提 ${counts.submit} / 作废 ${counts.void} / 待定 ${counts["withdrawn-pending"]}）`;
}

function printCounts(
  title: string,
  counts: Partial<Record<string, number>>,
  labels: Record<string, string>,
): void {
  const entries = Object.entries(counts).filter((entry): entry is [string, number] =>
    Boolean(entry[1]),
  );
  if (!entries.length) return;
  console.log(
    `${title}：${entries.map(([key, value]) => `${labels[key] ?? key} ${value}`).join(" / ")}`,
  );
}

function printItem(item: DraftRetirementReport["items"][number]): void {
  const source =
    item.source === "activity" ? "活动" : item.source === "legacy-activity" ? "旧活动键" : "手工";
  const withdrawn = item.withdrawn ? "，已撤回" : "";
  if (item.action === "submit") {
    const backfilled = item.changedFields.length
      ? `补全 ${item.changedFields.map((field) => FIELD_LABELS[field] ?? field).join("、")}`
      : "无需补全";
    const remap = item.categoryRemapped ? `；分类重映射 → ${item.categoryRemapped.toCode}` : "";
    console.log(`- ${item.recordId} [${source}${withdrawn}] 补提；${backfilled}${remap}`);
    return;
  }
  if (item.action === "void") {
    const reasons = item.voidReasons
      .map((reason) => VOID_REASON_LABELS[reason] ?? reason)
      .join("、");
    console.log(`- ${item.recordId} [${source}${withdrawn}] 作废；原因：${reasons}`);
    return;
  }
  console.log(
    `- ${item.recordId} [${source}${withdrawn}] 撤回待定；${item.eligibleToSubmit ? "可补提" : "不可补提"}`,
  );
}

function printApplyResult(result: DraftRetirementApplyResult): void {
  console.log(`\nrunId：${result.runId}`);
  console.log(`备份：${result.backupPath}`);
  console.log(`补提：${result.submittedRecordIds.length}；作废：${result.voidedRecordIds.length}`);
  if (result.failures.length) {
    console.log("失败项：");
    for (const failure of result.failures) console.log(`- ${failure.recordId}：${failure.message}`);
  }
  const check = result.postCheck;
  console.log("事后核对：");
  console.log(`  · 可编辑草稿残留：${check.activeDraftCount}（要求 0）`);
  console.log(
    `  · 补提后 PENDING：${check.submittedPendingCount}/${result.submittedRecordIds.length}`,
  );
  console.log(`  · 作废软删除：${check.voidedCount}/${result.voidedRecordIds.length}`);
  console.log(
    `  · 接待关联已清空：${check.clearedRegistrationCount}/${result.clearedRegistrationIds.length}`,
  );
  console.log(
    `  · 悬挂登记行：${check.danglingRegistrationCount}（执行前 ${check.baselineDanglingRegistrationCount}；本次新增 ${check.newDanglingRegistrationCount}，要求 0）`,
  );
  if (check.baselineDanglingRegistrationCount > 0)
    console.log("    执行前已存在的悬挂不计入本次失败；软删除登记行不参与统计。");
  console.log(`  · 待补建接待：${check.servedWithoutRecordCount}（含执行前已存在；信息项）`);
  console.log(`结论：${result.postCheckPassed ? "通过" : "未通过，请检查失败项后重跑"}`);
}

const FIELD_LABELS: Record<string, string> = {
  ownerName: "机主姓名",
  ownerPhone: "机主电话",
  deviceModel: "机型",
  repairDate: "维修日期",
  categoryId: "分类",
};

const VOID_REASON_LABELS: Record<string, string> = {
  "result-not-completed": "结果不是已完成",
  "duration-missing-or-invalid": "时长缺失或无效",
  "owner-name-missing": "缺机主姓名",
  "owner-phone-missing-or-invalid": "电话缺失或无效",
  "device-model-missing": "缺机型",
  "repair-date-missing-or-invalid": "日期缺失或无效",
  "category-missing-or-invalid": "分类缺失或无效",
  "content-too-long": "维修内容超长",
  "submission-incomplete": "其他提交校验未过",
  "withdrawn-policy-void": "已撤回按作废处置",
};

main()
  .catch((error: unknown) => {
    console.error("草稿盘点 / 处置失败：", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
