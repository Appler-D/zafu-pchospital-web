import { createHash } from "node:crypto";
import { repairFieldLimits } from "@/config/repairs";

/**
 * 历史修机数据导入——纯解析与匹配逻辑，不碰数据库。
 *
 * 数据来自腾讯在线文档表单（两张收集表的真实列结构已核对，见 tools 脚本说明）。
 * 必需列只有姓名/日期/正文三列；时长与分类列可能整列缺失，由 `--default-duration`
 * 与 `--fallback-category` 的社团口径补录（备注留痕），对不上时脚本会报「缺少列」而不是猜。
 */

export type HistoryInputRow = {
  lineNo: number;
  raw: Partial<Record<HistoryField, string>>;
};

export const HISTORY_COLUMNS = ["name", "repairDate", "content"] as const;
export const HISTORY_OPTIONAL_COLUMNS = [
  "durationMinutes",
  "categoryName",
  "result",
  "remark",
] as const;
export type HistoryColumnName = (typeof HISTORY_COLUMNS)[number];
export type HistoryOptionalName = (typeof HISTORY_OPTIONAL_COLUMNS)[number];
export type HistoryField = HistoryColumnName | HistoryOptionalName;

const HEADER_ALIASES: Record<HistoryField, readonly string[]> = {
  name: ["姓名", "维修人", "维修人员", "维修人员姓名", "维修成员", "成员", "name"],
  repairDate: ["维修日期", "日期", "提交时间", "登记时间", "date"],
  durationMinutes: [
    "维修时长（分钟）",
    "维修时长(分钟)",
    "维修时长",
    "时长（分钟）",
    "时长(分钟)",
    "时长",
    "分钟",
    "duration",
  ],
  categoryName: ["故障分类", "分类", "category"],
  content: ["维修内容", "内容", "故障", "故障描述", "content"],
  result: ["维修结果", "结果", "result"],
  remark: ["备注", "remark"],
};

function normalizeHeader(value: string): string {
  return value
    .trim()
    .replace(/^\ufeff/, "")
    .replace(/[(（][^()（）]*[)）]\s*$/g, "")
    .trim();
}

/** 表头行 → 列名映射；缺任一必需列时报错并列出可识别的表头。 */
export function mapHistoryHeader(cells: string[]): {
  fields: Partial<Record<HistoryField, number>>;
  missing: HistoryColumnName[];
} {
  const fields: Partial<Record<HistoryField, number>> = {};
  cells.forEach((cell, index) => {
    const value = normalizeHeader(cell);
    for (const [field, aliases] of Object.entries(HEADER_ALIASES) as [HistoryField, string[]][]) {
      if (
        fields[field] === undefined &&
        aliases.some((alias) => alias.toLowerCase() === value.toLowerCase())
      ) {
        fields[field] = index;
      }
    }
  });
  const missing = HISTORY_COLUMNS.filter((column) => fields[column] === undefined);
  return { fields, missing };
}

/** 最小 CSV 解析：双引号包裹、转义引号、CRLF，够用且无新依赖。 */
export function parseDelimitedRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const source = text.replace(/^\ufeff/, "");
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && source[i + 1] === "\n") i += 1;
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((entry) => entry.some((value) => normalizeHeader(value) !== ""));
}

export type HistoryMemberRef = { profileId: string; realName: string };
export type HistoryCategoryRef = { id: string; name: string; isActive: boolean };

export type ValidHistoryRow = {
  lineNo: number;
  memberProfileId: string;
  categoryId: string;
  repairDate: string;
  durationMinutes: number;
  content: string;
  result: "COMPLETED" | "NOT_COMPLETED";
  remark: string | null;
  idempotencyKey: string;
};

/**
 * 姓名尚未在册、但其余字段全部有效的行。
 * 先落 `repair_history_pending` 暂存，等该姓名的新成员注册/建档后由自动补录认领；
 * `fingerprint` 与 `ValidHistoryRow.idempotencyKey` 同一套算法（不含成员归属），
 * 因此「暂存 → 认领」与「重跑 CLI 直接导入」天然去重，谁先到都不会重复入库。
 */
export type PendingHistoryRow = {
  lineNo: number;
  /** 匹配用的姓名：一格多人已取第一人、班级前缀已剥离（与导入口径一致）。 */
  realName: string;
  categoryId: string;
  repairDate: string;
  durationMinutes: number;
  content: string;
  result: "COMPLETED" | "NOT_COMPLETED";
  remark: string | null;
  fingerprint: string;
};

export type RejectedHistoryRow = { lineNo: number; reason: string };

export type HistoryPlan = {
  valid: ValidHistoryRow[];
  /** 仅当 `options.storePendingUnmatched` 时非空。 */
  pending: PendingHistoryRow[];
  rejected: RejectedHistoryRow[];
};

/** `YYYY-M-D` / `YYYY/M/D` / `YYYY.M.D`，允许带 `HH:mm(:ss)` 尾巴（表单「提交时间（自动）」列）。 */
export function normalizeHistoryDate(value: string): string | null {
  const match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/.exec(
    value.trim(),
  );
  if (!match) return null;
  const [, year, month, day] = match;
  const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  if (Number.isNaN(new Date(`${iso}T00:00:00.000Z`).valueOf())) return null;
  return iso;
}

/**
 * 维修时长文本 → 整数分钟。表单里是自由文本（"30分钟/1h/半小时/1小时05分/20"），
 * 口径为社团确认的规则（历史数据收集表适配）：
 * `X分钟|分|min(s)` 按分钟；`X小时|Xh` 按 60 倍；`半小时` 30；`两小时` 120；
 * `X小时Y分` 相加；**纯数字 ≤12 按小时、>12 按分钟**；其余（"一次"、中文数字等）拒收转人工。
 */
export function parseHistoryDuration(value: string): number | null {
  const v = value
    .trim()
    .toLowerCase()
    .replace(/[。．]+$/, "")
    .replace(/^(约|大约|大概)\s*/, "")
    .replace(/\s*(左右|前后)$/, "");
  if (!v) return null;
  let minutes: number | null = null;
  if (v === "半小时" || v === "半个小时" || v === "半h") minutes = 30;
  else if (/^两\s*(?:个)?小时$/.test(v)) minutes = 120;
  else {
    const hourMinute = /^(\d{1,2})\s*(?:个)?小时\s*(\d{1,2})\s*分?$/.exec(v);
    const hour = /^(\d+(?:\.\d+)?)\s*(?:个)?(小时|h|hr|hrs)$/.exec(v);
    const minute = /^(\d+(?:\.\d+)?)\s*(分钟|分|min|mins)$/.exec(v);
    const bare = /^(\d+(?:\.\d+)?)$/.exec(v);
    if (hourMinute) minutes = Number(hourMinute[1]) * 60 + Number(hourMinute[2]);
    else if (hour) minutes = Number(hour[1]) * 60;
    else if (minute) minutes = Number(minute[1]);
    else if (bare) {
      const n = Number(bare[1]);
      minutes = n <= 12 ? n * 60 : n;
    }
  }
  if (minutes === null) return null;
  const rounded = Math.round(minutes);
  if (
    rounded < repairFieldLimits.durationMinutesMin ||
    rounded > repairFieldLimits.durationMinutesMax
  )
    return null;
  return rounded;
}

/** 一格多名维修人员（`，`、`、`、逗号、分号或空白分隔）时取第一人——社团确认的归属口径。 */
export function extractHistoryNames(cell: string): string[] {
  return cell
    .split(/[，、,;；/|]+|\s+/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/** 「计算机233蔡廷耀」这类姓名前粘连班级号的写法：剥掉「中文班级名+数字」前缀取后面的姓名。 */
export function stripClassPrefixHistoryName(name: string): string | null {
  const match = /^[^\d]{0,10}\d{2,4}([\u4e00-\u9fa5·]{2,4})$/.exec(name);
  return match ? match[1] : null;
}

/**
 * 行指纹：规范化字段做哈希，同一行重复导入天然幂等。
 *
 * 只含**业务字段**，刻意排除两类东西：
 * - 成员归属（`memberProfileId`）：同一条历史行在「导出时已建成员」与「注册后自动补录」
 *   两条路径下必须得到同一个键 —— 否则同一条记录会被两边各写一次；
 * - 备注（`remark`）：其中混着补录口径的留痕（默认时长、兜底分类等），换个 `--default-duration`
 *   重跑就会因备注文本变化而算成新行，把「幂等」打破。备注不是业务标识字段。
 *
 * 业务字段完全相同的行由 `classifyHistoryRows` 追加**出现序号**（`#2`、`#3`…）：
 * 义修现场「同一个人同一天给多台机器做同样的活」（一天 5 台「清灰 30 分钟」）是 5 次真实维修，
 * 只按业务字段会把第 2..N 台当成重复行丢掉 —— 2026-09-30 生产实测两张收集表被吞 126 行，
 * 逐行复核后约 119 行机主各不相同。序号让「同组第 1 行保持原键」（与既有导入一致，重跑即跳过）、
 * 「第 2..N 行可增量补录」，既修掉误吞，又不破坏重跑的幂等。
 */
export function historyRowKey(row: {
  realName: string;
  categoryId: string;
  repairDate: string;
  durationMinutes: number;
  content: string;
  result: string;
}): string {
  const digest = createHash("sha256").update(JSON.stringify(row), "utf8").digest("hex");
  return `history-import:${digest}`;
}

/**
 * 按姓名匹配成员、按名称匹配分类，产出可导入行、待认领行与逐行拒收原因。
 * 重名（同名多位在册成员）不猜归属，整组拒收转人工。
 * 收集表实况适配（口径均经社团确认）：
 * - 维修人员一格多人 → 归属第一人，原文进备注留痕；
 * - 姓名前粘连班级号（「计算机233蔡廷耀」）→ 剥离前缀后匹配，并在备注留痕；
 * - 无时长列/空值 → `options.defaultDurationMinutes` 补录并留痕；
 * - 无分类列/空值 → `options.fallbackCategoryId` 统一挂兜底分类并留痕；
 * - `options.storePendingUnmatched`（CLI `--apply` 用）：姓名尚未在册的行不拒收，
 *   返回在 `pending` 里落暂存，等本人注册后自动补录（评审 1 的「只导入一次」）。
 */
export function classifyHistoryRows(
  inputs: HistoryInputRow[],
  refs: {
    members: HistoryMemberRef[];
    categories: HistoryCategoryRef[];
    today: string;
    options?: {
      defaultDurationMinutes?: number;
      fallbackCategoryId?: string;
      storePendingUnmatched?: boolean;
    };
  },
): HistoryPlan {
  const byName = new Map<string, HistoryMemberRef[]>();
  for (const member of refs.members) {
    const key = member.realName.trim();
    byName.set(key, [...(byName.get(key) ?? []), member]);
  }
  const categoryByName = new Map(
    refs.categories.map((category) => [category.name.trim(), category]),
  );
  const options = refs.options ?? {};

  const valid: ValidHistoryRow[] = [];
  const pending: PendingHistoryRow[] = [];
  const rejected: RejectedHistoryRow[] = [];

  /**
   * 同组（业务字段相同 → 基础指纹相同）行的出现计数，按文件行序。
   * 第 1 次保持原键（与既有导入的行一致，重跑即跳过）；第 2..N 次追加 `#N`（可增量补录）。
   */
  const occurrences = new Map<string, number>();
  const keyWithOccurrence = (base: string): string => {
    const count = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, count);
    return count === 1 ? base : `${base}#${count}`;
  };

  for (const input of inputs) {
    const reject = (reason: string) => rejected.push({ lineNo: input.lineNo, reason });
    const notes: string[] = [];
    const nameCell = (input.raw.name ?? "").trim();
    if (!nameCell) {
      reject("缺少姓名");
      continue;
    }
    const names = extractHistoryNames(nameCell);
    if (names.length > 1) notes.push(`维修人员一格多人，归属第一人；原格：${nameCell}`);
    const [firstName] = names;
    let candidates = byName.get(firstName) ?? [];
    let resolvedName = firstName;
    if (candidates.length === 0) {
      const stripped = stripClassPrefixHistoryName(firstName);
      if (stripped) {
        candidates = byName.get(stripped) ?? [];
        if (candidates.length > 0) notes.push(`姓名按班级前缀剥离匹配：${firstName} → ${stripped}`);
        else {
          // 剥离结果没有对应在册成员：按剥离后的姓名暂存，等本人注册后认领。
          resolvedName = stripped;
          notes.push(
            `姓名按班级前缀剥离（该成员尚未在册，暂存待认领）：${firstName} → ${stripped}`,
          );
        }
      }
    }
    if (candidates.length > 1) {
      reject(`姓名重名，需人工确认归属：${firstName}`);
      continue;
    }
    const unmatched = candidates.length === 0;
    if (unmatched && !options.storePendingUnmatched) {
      reject(`未找到在册成员：${firstName}`);
      continue;
    }
    const repairDate = normalizeHistoryDate(input.raw.repairDate ?? "");
    if (!repairDate) {
      reject(`维修日期无效：${input.raw.repairDate ?? "（空）"}`);
      continue;
    }
    if (repairDate < repairFieldLimits.repairDateMin || repairDate > refs.today) {
      reject(`维修日期超出范围：${repairDate}`);
      continue;
    }
    const durationText = (input.raw.durationMinutes ?? "").trim();
    let durationMinutes = durationText ? parseHistoryDuration(durationText) : null;
    if (durationText && durationMinutes === null) {
      reject(
        `维修时长无法解析（参考口径：分钟/小时/半小时；须为 ${repairFieldLimits.durationMinutesMin}–${repairFieldLimits.durationMinutesMax} 的整数分钟）：${durationText}`,
      );
      continue;
    }
    if (!durationText && durationMinutes === null && options.defaultDurationMinutes !== undefined) {
      durationMinutes = options.defaultDurationMinutes;
      notes.push(`时长缺失，按默认 ${durationMinutes} 分钟补录（社团口径）`);
    }
    if (durationMinutes === null) {
      reject("缺少维修时长（未提供默认补录口径）");
      continue;
    }
    const categoryName = (input.raw.categoryName ?? "").trim();
    let categoryId: string | undefined;
    if (categoryName) {
      const category = categoryByName.get(categoryName);
      if (!category) {
        reject(`未找到故障分类：${categoryName}`);
        continue;
      }
      if (!category.isActive) {
        reject(`故障分类已停用：${categoryName}`);
        continue;
      }
      categoryId = category.id;
    } else if (options.fallbackCategoryId) {
      categoryId = options.fallbackCategoryId;
      notes.push("故障分类挂兜底分类（收集表无分类列，社团口径）");
    } else {
      reject("缺少故障分类（未提供兜底分类）");
      continue;
    }
    const content = (input.raw.content ?? "").trim();
    if (!content) {
      reject("缺少维修内容");
      continue;
    }
    if (content.length > repairFieldLimits.contentMaxLength) {
      reject(`维修内容超过 ${repairFieldLimits.contentMaxLength} 字`);
      continue;
    }
    const remarkParts = [
      (input.raw.remark ?? "").trim(),
      ...notes.map((note) => `〔导入留痕〕${note}`),
    ].filter((part) => part !== "");
    const remark = remarkParts.join("；") || null;
    if (remark && remark.length > repairFieldLimits.remarkMaxLength) {
      reject(`备注超过 ${repairFieldLimits.remarkMaxLength} 字`);
      continue;
    }
    const rawResult = (input.raw.result ?? "").trim();
    let result: ValidHistoryRow["result"] = "COMPLETED";
    if (rawResult) {
      if (rawResult === "已完成" || rawResult === "COMPLETED") result = "COMPLETED";
      else if (rawResult === "未完成" || rawResult === "NOT_COMPLETED") result = "NOT_COMPLETED";
      else {
        reject(`维修结果无效：${rawResult}`);
        continue;
      }
    }
    if (unmatched) {
      pending.push({
        lineNo: input.lineNo,
        realName: resolvedName,
        categoryId,
        repairDate,
        durationMinutes,
        content,
        result,
        remark,
        fingerprint: keyWithOccurrence(
          historyRowKey({
            realName: resolvedName,
            categoryId,
            repairDate,
            durationMinutes,
            content,
            result,
          }),
        ),
      });
      continue;
    }
    const memberProfileId = candidates[0].profileId;
    // 指纹用成员档案里的姓名（而非输入格里的写法）：与 pending 行的 realName 同一口径，
    // 「暂存 → 认领」与「重跑 CLI」才能算出同一个键。
    const realName = candidates[0].realName.trim();
    valid.push({
      lineNo: input.lineNo,
      memberProfileId,
      categoryId,
      repairDate,
      durationMinutes,
      content,
      result,
      remark,
      idempotencyKey: keyWithOccurrence(
        historyRowKey({
          realName,
          categoryId,
          repairDate,
          durationMinutes,
          content,
          result,
        }),
      ),
    });
  }
  return { valid, pending, rejected };
}
