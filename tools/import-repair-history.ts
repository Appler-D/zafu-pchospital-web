import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { authorizeUser } from "../src/lib/auth/authorize";
import { disconnectDb, getDb } from "../src/lib/db/client";
import { shanghaiToday } from "../src/lib/shanghai-date";
import {
  classifyHistoryRows,
  extractHistoryNames,
  mapHistoryHeader,
  normalizeHistoryDate,
  parseDelimitedRows,
  parseHistoryDuration,
  HISTORY_OPTIONAL_COLUMNS,
  HISTORY_COLUMNS,
  type HistoryInputRow,
} from "../src/features/repairs/repair-history-import";
import {
  applyHistoryImport,
  storePendingHistory,
} from "../src/features/repairs/repair-history-import-service";

/**
 * 历史修机数据导入。
 *
 * 用法：
 *   corepack pnpm import:repair-history <文件.csv|.xlsx> [--actor=<userId>] [--apply]
 *     [--fallback-category=<分类code>] [--default-duration=<分钟>] [--parse-only]
 *
 * - 缺省是 dry-run：只做表头识别、姓名/分类匹配与逐行校验，报告问题行，不写库；
 * - `--parse-only`：完全不连库的纯解析审计（无 DB 环境交付报告用）。只核对
 *   日期/时长/正文可解析性并汇总去重的维修人员姓名，不做成员与分类匹配；
 * - 确认报告没问题后加 `--apply` 真正导入；`--actor` 必须是拥有 `repair:review`
 *   权限的管理员用户 ID（写审计用）；
 * - `--fallback-category`：收集表没有故障分类列（实况）时，所有行统一挂
 *   该 code 的分类；库里不存在时 `--apply` 会以「历史导入」为名自动创建（dry-run 只提示）；
 * - `--default-duration`：整列缺失或单行为空时按该分钟数补录并在备注留痕（社团口径：
 *   电脑医院收集表无时长列，按 30 分钟补）；
 * - 行指纹幂等：同一行重复执行只会跳过，不会重复入库；
 * - 「先修机、后注册」的行（姓名尚未在册但字段有效）不再直接拒收：`--apply` 时存入
 *   `repair_history_pending` 暂存表，该姓名的新成员在**邀请码注册 / 面试通过发放 /
 *   管理端新增**建档后自动补录（source = history_import_claim，见评审 1）；
 *   双保险：成员建档后对同一文件重跑 `--apply` 也能补，已入库行会被指纹跳过；
 * - 时长解析与多人格归属的口径集中在 repair-history-import.ts 的注释里，均经社团
 *   确认（维修人员列→第一人；纯数字 ≤12 按小时、>12 按分钟），脚本不额外猜列。
 */

async function readRows(file: string, buffer: Buffer): Promise<string[][]> {
  const ext = file.toLowerCase();
  if (ext.endsWith(".csv")) {
    const text = buffer.toString("utf8");
    // 腾讯文档/Excel 另存的 CSV 常见 GBK 编码，按 UTF-8 解码会出现替换符乱码。
    if (text.includes("\uFFFD"))
      throw new Error("CSV 疑似非 UTF-8 编码（可能出现乱码），请另存为 UTF-8 CSV 后重试。");
    return parseDelimitedRows(text);
  }
  if (ext.endsWith(".xlsx")) {
    const { default: ExcelJS } = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new Error("xlsx 里没有工作表");
    const rows: string[][] = [];
    sheet.eachRow((row) => {
      rows.push(
        Array.from({ length: row.cellCount }, (_, index) => {
          const value = row.getCell(index + 1).value;
          return formatCell(value);
        }),
      );
    });
    return rows.filter((row) => row.some((cell) => cell.trim() !== ""));
  }
  throw new Error("只支持 .csv 或 .xlsx 文件");
}

function formatCell(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, "0");
    const h = pad(value.getHours());
    const m = pad(value.getMinutes());
    const s = pad(value.getSeconds());
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${h}:${m}:${s}`;
  }
  if (typeof value === "object") {
    const cell = value as { text?: string; result?: unknown };
    if (typeof cell.text === "string") return cell.text;
    if (cell.result != null) return String(cell.result);
  }
  return String(value);
}

function buildInputs(rows: string[][], fields: Partial<Record<string, number>>): HistoryInputRow[] {
  const inputs: HistoryInputRow[] = [];
  for (let index = 1; index < rows.length; index += 1) {
    const cells = rows[index];
    const raw = {} as HistoryInputRow["raw"];
    for (const [field, column] of Object.entries(fields)) {
      raw[field as keyof typeof raw] = (cells[column as number] ?? "").trim();
    }
    inputs.push({ lineNo: index + 1, raw });
  }
  return inputs;
}

/** 不连库的纯解析审计：逐行核对与库无关的字段，并汇总姓名清单。 */
function parseOnlyReport(inputs: HistoryInputRow[]): void {
  const issues: { lineNo: number; reason: string }[] = [];
  const nameCount = new Map<string, number>();
  const multiNameLines: number[] = [];
  let durationDefaulted = 0;
  for (const input of inputs) {
    const nameCell = (input.raw.name ?? "").trim();
    if (!nameCell) issues.push({ lineNo: input.lineNo, reason: "缺少姓名" });
    else {
      const names = extractHistoryNames(nameCell);
      if (names.length > 1) multiNameLines.push(input.lineNo);
      nameCount.set(names[0], (nameCount.get(names[0] ?? "") ?? 0) + 1);
    }
    const date = normalizeHistoryDate(input.raw.repairDate ?? "");
    if (!date) issues.push({ lineNo: input.lineNo, reason: `日期无效：${input.raw.repairDate}` });
    const durationText = (input.raw.durationMinutes ?? "").trim();
    if (!durationText) durationDefaulted += 1;
    else if (parseHistoryDuration(durationText) === null)
      issues.push({ lineNo: input.lineNo, reason: `时长无法解析：${durationText}` });
    const content = (input.raw.content ?? "").trim();
    if (!content) issues.push({ lineNo: input.lineNo, reason: "缺少维修内容" });
  }
  console.log(`总行数 ${inputs.length}`);
  console.log(`时长列为空的行（若给 --default-duration 将补录）：${durationDefaulted}`);
  console.log(`一格多名维修人员（归属第一人）的行数：${multiNameLines.length}`);
  console.log(`字段级问题 ${issues.length} 条：`);
  for (const issue of issues) console.log(`  第 ${issue.lineNo} 行：${issue.reason}`);
  const names = [...nameCount.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`去重后的「维修人员第一姓名」共 ${names.length} 个（与在册成员比对用）：`);
  console.log(names.map(([name, count]) => `${name}×${count}`).join("、"));
}

/** dry-run 用占位 id 让分类校验通过（dry-run 不写库、指纹无意义）；--apply 不存在则创建。 */
async function resolveFallbackCategory(code: string, apply: boolean): Promise<string> {
  const db = getDb();
  const existing = await db.repairCategory.findFirst({ where: { code, deletedAt: null } });
  if (existing) {
    if (!existing.isActive) console.log(`警告：兜底分类 ${code} 已停用，仍按该分类导入。`);
    return existing.id;
  }
  if (!apply) {
    console.log(`dry-run：兜底分类 ${code} 尚不存在，--apply 时将自动创建（名称「历史导入」）。`);
    return "pending-create";
  }
  const created = await db.repairCategory.create({
    data: { id: randomUUID(), code, name: "历史导入", sortOrder: 999, createdAt: new Date() },
  });
  console.log(`已创建兜底分类：${created.code}（${created.name}）。`);
  return created.id;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const file = args.find((arg) => !arg.startsWith("--"));
  const apply = args.includes("--apply");
  const parseOnly = args.includes("--parse-only");
  const actorArg = args.find((arg) => arg.startsWith("--actor="))?.slice("--actor=".length);
  const fallbackCode = args
    .find((arg) => arg.startsWith("--fallback-category="))
    ?.slice("--fallback-category=".length);
  const defaultDurationArg = args
    .find((arg) => arg.startsWith("--default-duration="))
    ?.slice("--default-duration=".length);
  const defaultDuration = defaultDurationArg ? Number.parseInt(defaultDurationArg, 10) : undefined;
  if (defaultDurationArg && (!Number.isInteger(defaultDuration) || (defaultDuration as number) < 1))
    throw new Error("--default-duration 须为正整数分钟");
  if (!file) {
    console.error(
      "用法：pnpm import:repair-history <文件.csv|.xlsx> [--actor=<userId>] [--apply] " +
        "[--fallback-category=<code>] [--default-duration=<分钟>] [--parse-only]",
    );
    process.exitCode = 1;
    return;
  }
  if (apply && !actorArg) {
    console.error("--apply 必须同时提供 --actor=<管理员用户 ID>（需要 repair:review 权限）。");
    process.exitCode = 1;
    return;
  }

  const buffer = await readFile(file);
  const rows = await readRows(file, buffer);
  if (rows.length < 2) {
    console.error("文件里只有表头或为空，没有可导入的数据行。");
    process.exitCode = 1;
    return;
  }
  const { fields, missing } = mapHistoryHeader(rows[0]);
  if (missing.length) {
    console.error(`表头缺少必需列：${missing.join("、")}`);
    console.error(`识别到的表头：${rows[0].join(" | ")}`);
    console.error(
      `必需列别名：${HISTORY_COLUMNS.map((c) => `${c}=${HEADER_ALIAS_TEXT[c]}`).join("；")}`,
    );
    process.exitCode = 1;
    return;
  }
  const optional = HISTORY_OPTIONAL_COLUMNS.filter((column) => fields[column] === undefined);
  if (optional.length) console.log(`选填列缺失（按默认值处理）：${optional.join("、")}`);

  const inputs = buildInputs(rows, fields);
  if (parseOnly) {
    parseOnlyReport(inputs);
    return;
  }

  const db = getDb();
  const [memberRows, categories] = await Promise.all([
    db.memberProfile.findMany({
      where: { deletedAt: null, status: "ACTIVE" },
      select: { id: true, realName: true },
    }),
    db.repairCategory.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, isActive: true },
    }),
  ]);
  const members = memberRows.map((member) => ({ profileId: member.id, realName: member.realName }));
  const fallbackId = fallbackCode ? await resolveFallbackCategory(fallbackCode, apply) : undefined;
  const plan = classifyHistoryRows(inputs, {
    members,
    categories,
    today: shanghaiToday(),
    options: {
      defaultDurationMinutes: defaultDuration,
      fallbackCategoryId: fallbackId,
      // 姓名尚未在册的行不直接拒收：字段有效就先暂存，等本人注册后自动补录（评审 1）。
      storePendingUnmatched: true,
    },
  });

  console.log(
    `总行数 ${inputs.length}：可导入 ${plan.valid.length}，暂存待认领 ${plan.pending.length}（姓名尚未在册），拒收 ${plan.rejected.length}`,
  );
  for (const row of plan.rejected) console.log(`  第 ${row.lineNo} 行：${row.reason}`);
  if (plan.pending.length > 0) {
    const pendingNames = new Map<string, number>();
    for (const row of plan.pending)
      pendingNames.set(row.realName, (pendingNames.get(row.realName) ?? 0) + 1);
    console.log(
      `暂存名单（对该文件重跑 --apply 也能补）：${[...pendingNames.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `${name}×${count}`)
        .join("、")}`,
    );
  }
  if (!plan.valid.length && !plan.pending.length) {
    console.log("没有可导入的行。");
    await disconnectDb();
    return;
  }
  if (!apply) {
    console.log("dry-run 完成，未写库。确认无误后加 --apply 执行导入。");
    await disconnectDb();
    return;
  }
  const actor = await authorizeUser(actorArg, { requestId: `history-import-${Date.now()}` });
  const result = await applyHistoryImport(plan.valid, actor);
  const pendingResult = await storePendingHistory(plan.pending, actor, file);
  console.log(
    `导入完成：新增 ${result.inserted} 条，重复跳过 ${result.skipped} 条；` +
      `暂存待认领 ${pendingResult.stored} 条（重复跳过 ${pendingResult.skipped} 条）。`,
  );
  await disconnectDb();
}

const HEADER_ALIAS_TEXT: Record<(typeof HISTORY_COLUMNS)[number], string> = {
  name: "姓名/维修人员(姓名)/维修人/name",
  repairDate: "维修日期/日期/提交时间/date",
  content: "维修内容/内容/故障(描述)/content",
};

main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  await disconnectDb();
  process.exitCode = 1;
});
