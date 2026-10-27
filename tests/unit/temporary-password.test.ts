import assert from "node:assert/strict";
import test from "node:test";

import { generateTemporaryPassword } from "../../src/lib/security/temporary-password";

/**
 * 临时密码生成器：6 位数字、保留前导零。
 * 只钉行为不钉常量 —— 常量的取值由集成链路（1 小时有效期、10 分钟受限会话）实际验证。
 */
test("临时密码：6 位数字且保留前导零", () => {
  assert.equal(
    generateTemporaryPassword(() => 0),
    "000000",
  );
  assert.equal(
    generateTemporaryPassword(() => 42),
    "000042",
  );
  assert.equal(
    generateTemporaryPassword(() => 999_999),
    "999999",
  );
  // 默认走 crypto.randomInt：多取几次兜住格式漂移。
  for (let index = 0; index < 20; index += 1) assert.match(generateTemporaryPassword(), /^\d{6}$/);
});
