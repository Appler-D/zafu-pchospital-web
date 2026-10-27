import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync("src/app/member/notifications/page.tsx", "utf8");
const css = readFileSync("src/app/globals.css", "utf8");

test("消息通知页使用成员紧凑页头，不再使用官网式 PageHead", () => {
  assert.equal(page.includes('from "@/components/layout/PageHead"'), false);
  assert.equal(page.includes("<PageHead"), false);
  assert.ok(page.includes("member-notifications-workspace"));
  assert.ok(page.includes('className="member-page-head"'));
  assert.ok(page.includes('id="member-notifications-title"'));
  assert.match(
    css,
    /\.member-notifications-workspace\.page-head \{[^}]*padding-block: clamp\(1\.5rem, 3vw, 2\.5rem\)/,
  );
});
