import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serviceSource = readFileSync(
  "src/features/repair-activities/repair-activity-service.ts",
  "utf8",
);
const listPublicSource = serviceSource.slice(
  serviceSource.indexOf("async listPublic"),
  serviceSource.indexOf("async getPublic"),
);

test("管理端活动列表按活动时间倒序返回，最新在前", () => {
  assert.match(
    serviceSource,
    /async listAdmin[\s\S]*?orderBy: \[\{ activityAt: "desc" \}, \{ createdAt: "desc" \}, \{ id: "desc" \}\]/,
  );
});

test("公开列表按未结束升序、已结束降序的 SQL 排序返回", () => {
  assert.match(
    serviceSource,
    /const activeOrderBy = \[\s*\{ activityAt: "asc" \},\s*\{ createdAt: "asc" \},\s*\{ id: "asc" \},\s*\]/,
  );
  assert.match(
    serviceSource,
    /const endedOrderBy = \[\s*\{ activityAt: "desc" \},\s*\{ createdAt: "asc" \},\s*\{ id: "asc" \},\s*\]/,
  );
  assert.match(listPublicSource, /orderBy: activeOrderBy/);
  assert.match(listPublicSource, /orderBy: endedOrderBy/);
});
