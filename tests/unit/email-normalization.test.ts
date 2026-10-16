import assert from "node:assert/strict";
import test from "node:test";

import { AppError } from "../../src/lib/api/errors";
import {
  EMAIL_LOCAL_MAX_LENGTH,
  EMAIL_MAX_LENGTH,
  normalizeEmail,
} from "../../src/lib/security/normalization";

/** 断言抛 VALIDATION_FAILED（邮箱字段的稳定错误码）。 */
function assertInvalid(value: unknown): void {
  assert.throws(
    () => normalizeEmail(value),
    (error: unknown) => error instanceof AppError && error.code === "VALIDATION_FAILED",
    `应拒绝：${String(value)}`,
  );
}

test("邮箱规范化：trim、整体小写、保留 +tag 与 local-part 的点", () => {
  assert.equal(normalizeEmail("  Alice+Tag@Example.COM "), "alice+tag@example.com");
  assert.equal(normalizeEmail("a.b.c@sub.example.co"), "a.b.c@sub.example.co");
  // 不做 Gmail 式去点 / 去加号 / 别名归并：不同写法是不同的规范化值。
  assert.notEqual(normalizeEmail("a.b@gmail.com"), normalizeEmail("ab@gmail.com"));
  assert.notEqual(normalizeEmail("a+x@gmail.com"), normalizeEmail("a@gmail.com"));
});

test("邮箱规范化：边界长度", () => {
  // local-part 64 合法、65 拒绝。
  const local64 = "a".repeat(EMAIL_LOCAL_MAX_LENGTH);
  const local65 = "a".repeat(EMAIL_LOCAL_MAX_LENGTH + 1);
  assert.equal(normalizeEmail(`${local64}@example.com`), `${local64}@example.com`);
  assertInvalid(`${local65}@example.com`);
  // 整个地址 191 合法、192 拒绝（与身份列 VARCHAR(191) 对齐）。
  const domainLength = EMAIL_MAX_LENGTH - EMAIL_LOCAL_MAX_LENGTH - 1; // 126
  const domain191 = `${"b".repeat(63)}.${"c".repeat(domainLength - 63 - 1)}`;
  assert.equal(domain191.length, domainLength);
  const at191 = `${local64}@${domain191}`;
  assert.equal(at191.length, EMAIL_MAX_LENGTH);
  assert.equal(normalizeEmail(at191), at191);
  assertInvalid(`${at191}x`);
});

test("邮箱规范化：拒绝非 ASCII、空白、控制字符与显示名 / 多地址", () => {
  for (const value of [
    "",
    "   ",
    "plain-address",
    "user@例え.jp",
    "用户@example.com",
    "a b@example.com", // 内部空白
    "a\u0000b@example.com", // 控制字符
    "Alice <alice@example.com>", // 显示名
    "a@example.com, b@example.com", // 多地址
    "a@example.com;b@example.com",
  ]) {
    assertInvalid(value);
  }
});

test("邮箱规范化：local-part 为 dot-atom（拒绝引号、首尾点、连续点、非法字符）", () => {
  for (const value of [
    '"alice"@example.com', // 带引号的 local-part
    ".alice@example.com",
    "alice.@example.com",
    "ali..ce@example.com",
    "ali(ce)@example.com",
    "ali\\ce@example.com",
  ]) {
    assertInvalid(value);
  }
});

test("邮箱规范化：域名是合法 DNS 标签且含分隔点（拒绝域字面量与非法标签）", () => {
  for (const value of [
    "a@example", // 无域名分隔点
    "a@[127.0.0.1]", // 域字面量
    "a@-example.com",
    "a@example-.com",
    "a@exa_mple.com",
    "a@.example.com",
    "a@example..com",
    "a@example.com.", // 末尾空标签
    `a@${"x".repeat(64)}.com`, // 标签超过 63
  ]) {
    assertInvalid(value);
  }
});

test("邮箱规范化：非字符串值一律拒绝（不做强制转换）", () => {
  for (const value of [undefined, null, 42, {}, ["a@b.com"]]) {
    assertInvalid(value);
  }
});
