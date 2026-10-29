import assert from "node:assert/strict";
import test from "node:test";
import { AdminGetCache } from "../../src/features/admin/admin-get-cache";

test("默认容量 100 项；命中更新 LRU，超过容量淘汰最久未使用项", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const cache = new AdminGetCache<number>();
  t.after(() => cache.clear());
  for (let i = 0; i < 100; i++) cache.set(String(i), i);
  assert.equal(cache.get("0"), 0);
  cache.set("100", 100);
  assert.equal(cache.size, 100);
  assert.equal(cache.get("1"), undefined);
  assert.equal(cache.get("0"), 0);
});

test("TTL 是绝对期限，读取不续期；空闲时定时器主动删除过期对象", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const cache = new AdminGetCache<string>();
  t.after(() => cache.clear());
  cache.set("first", "first");
  t.mock.timers.tick(10_000);
  cache.set("second", "second");
  assert.equal(cache.get("first"), "first");
  t.mock.timers.tick(5_000);
  assert.equal(cache.size, 1);
  assert.equal(cache.get("first"), undefined);
  t.mock.timers.tick(10_000);
  assert.equal(cache.size, 0);
});

test("大量筛选不会积累过期对象，显式清理取消回收定时器", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const cache = new AdminGetCache<number>();
  t.after(() => cache.clear());
  for (let i = 0; i < 256; i++) {
    cache.set(`query=${i}`, i);
    t.mock.timers.tick(16_000);
    assert.equal(cache.size, 0);
  }
  cache.set("new", 1);
  cache.clear();
  t.mock.timers.tick(20_000);
  assert.equal(cache.size, 0);
});
