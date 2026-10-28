import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serviceSource = readFileSync(
  "src/features/repair-activities/repair-activity-service.ts",
  "utf8",
);

test("管理端活动列表按活动时间倒序返回，最新在前", () => {
  assert.match(
    serviceSource,
    /async listAdmin[\s\S]*?orderBy: \[\{ activityAt: "desc" \}, \{ createdAt: "desc" \}, \{ id: "desc" \}\]/,
  );
  // 公开列表的既有顺序由纯函数决定，不跟随管理端倒序。
  assert.match(serviceSource, /async listPublic[\s\S]*?sortRepairActivitiesForPublicList/);
});
