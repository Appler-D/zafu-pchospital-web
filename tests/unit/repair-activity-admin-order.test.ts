import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serviceSource = readFileSync(
  "src/features/repair-activities/repair-activity-service.ts",
  "utf8",
);
const listPublicSource = serviceSource.slice(
  serviceSource.indexOf("async listPublic("),
  serviceSource.indexOf("async listPublicForHomePreview("),
);
const homePreviewSource = serviceSource.slice(
  serviceSource.indexOf("async listPublicForHomePreview("),
  serviceSource.indexOf("async getPublic("),
);

test("管理端活动列表按活动时间倒序返回，最新在前", () => {
  assert.match(
    serviceSource,
    /async listAdmin[\s\S]*?orderBy: \[\{ activityAt: "desc" \}, \{ createdAt: "desc" \}, \{ id: "desc" \}\]/,
  );
});

test("公开列表与首页预览共用未结束升序、已结束降序的 SQL 排序", () => {
  assert.match(
    serviceSource,
    /const PUBLIC_ACTIVE_ORDER_BY = \[\s*\{ activityAt: "asc" \},\s*\{ createdAt: "asc" \},\s*\{ id: "asc" \},\s*\]/,
  );
  assert.match(
    serviceSource,
    /const PUBLIC_ENDED_ORDER_BY = \[\s*\{ activityAt: "desc" \},\s*\{ createdAt: "asc" \},\s*\{ id: "asc" \},\s*\]/,
  );
  assert.match(listPublicSource, /orderBy: PUBLIC_ACTIVE_ORDER_BY/);
  assert.match(listPublicSource, /orderBy: PUBLIC_ENDED_ORDER_BY/);
  assert.match(homePreviewSource, /orderBy: PUBLIC_ACTIVE_ORDER_BY/);
});
