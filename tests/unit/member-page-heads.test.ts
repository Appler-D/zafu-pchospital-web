import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const memberPageHead = readFileSync("src/components/member/MemberPageHead.tsx", "utf8");
const css = readFileSync("src/app/globals.css", "utf8");

const pages = {
  favorites: "src/app/member/favorites/page.tsx",
  newRepair: "src/app/member/repairs/new/page.tsx",
  repairDetail: "src/app/member/repairs/[id]/page.tsx",
  repairEdit: "src/app/member/repairs/[id]/edit/page.tsx",
};

test("成员收藏与维修子页统一使用 MemberPageHead，不再使用官网式 PageHead", () => {
  assert.ok(memberPageHead.includes('className="member-page-head"'));
  assert.ok(memberPageHead.includes('className="sec-title" id={id}'));
  assert.ok(memberPageHead.includes("member-section__tag"));

  for (const [name, path] of Object.entries(pages)) {
    const source = readFileSync(path, "utf8");
    assert.equal(source.includes('from "@/components/layout/PageHead"'), false, name);
    assert.equal(source.includes("<PageHead"), false, name);
    assert.ok(source.includes("MemberPageHead"), name);
  }

  const favorites = readFileSync(pages.favorites, "utf8");
  assert.ok(favorites.includes("member-compact-workspace"));
  for (const path of [pages.newRepair, pages.repairDetail, pages.repairEdit]) {
    assert.ok(readFileSync(path, "utf8").includes('className="repair-page"'));
  }
  assert.match(css, /\.repair-page \.member-page-head \{[^}]*margin-bottom: 0/);
});
