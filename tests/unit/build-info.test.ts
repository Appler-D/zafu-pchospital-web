import assert from "node:assert/strict";
import test from "node:test";

import { parseBuildCommit } from "../../src/lib/build-info";

// 后台版本显示只接受合法 commit，非法值一律显示「未知」。

test("构建版本：完整 SHA 规整为小写并取前 7 位", () => {
  assert.deepEqual(parseBuildCommit("  5FDC1F8A1B2C3D4E5F60718293A4B5C6D7E8F901 \n"), {
    commit: "5fdc1f8a1b2c3d4e5f60718293a4b5c6d7e8f901",
    short: "5fdc1f8",
  });
});

test("构建版本：7 位短 SHA 原样保留", () => {
  assert.deepEqual(parseBuildCommit("a298aaa"), { commit: "a298aaa", short: "a298aaa" });
});

test("构建版本：空 / 分支名 / 过短 / 非十六进制都返回未知", () => {
  for (const raw of [
    "",
    "   ",
    null,
    undefined,
    "main",
    "123456",
    "5fdc1f8-not-a-sha",
    "5fdc1f8a1b2c3d4e5f60718293a4b5c6d7e8f901x",
  ]) {
    assert.deepEqual(parseBuildCommit(raw), { commit: "", short: "" }, String(raw));
  }
});
