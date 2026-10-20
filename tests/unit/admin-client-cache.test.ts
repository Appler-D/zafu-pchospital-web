import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { adminFetch, clearAdminCache } from "../../src/features/admin/admin-client";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearAdminCache();
});
const response = (data: unknown) => new Response(JSON.stringify({ success: true, data }));

test("删除前开始的分页响应不能重新填充已失效缓存", async () => {
  let finishOldPage!: (value: Response) => void;
  let reads = 0;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === "DELETE") return response(null);
    reads++;
    if (reads === 1)
      return new Promise<Response>((resolve) => {
        finishOldPage = resolve;
      });
    return response([{ id: "remaining" }]);
  };
  const pending = adminFetch<{ id: string }[]>("/applications?page=2");
  await adminFetch("/applications/deleted", { method: "DELETE" });
  finishOldPage(response([{ id: "deleted" }]));
  await pending;
  const refreshed = await adminFetch<{ id: string }[]>("/applications?page=2");
  assert.equal(reads, 2);
  assert.ok(refreshed.ok);
  assert.deepEqual(refreshed.data, [{ id: "remaining" }]);
  await adminFetch("/applications?page=2");
  assert.equal(reads, 2, "没有写操作时仍复用有效缓存");
});

test("显式清理缓存也阻止在途旧响应回填", async () => {
  let finish!: (value: Response) => void;
  let reads = 0;
  globalThis.fetch = async () => {
    reads++;
    if (reads === 1)
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    return response("new");
  };
  const pending = adminFetch("/applications");
  clearAdminCache();
  finish(response("old"));
  await pending;
  assert.deepEqual(await adminFetch("/applications"), {
    ok: true,
    data: "new",
    pagination: undefined,
  });
  assert.equal(reads, 2);
});

test("删除进行中完成的旧读取在删除结束后同样失效", async () => {
  let finishDelete!: (value: Response) => void;
  let reads = 0;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === "DELETE") {
      return new Promise<Response>((resolve) => {
        finishDelete = resolve;
      });
    }
    reads++;
    return response(reads === 1 ? "old" : "new");
  };
  const deletion = adminFetch("/applications/deleted", { method: "DELETE" });
  await adminFetch("/applications");
  finishDelete(response(null));
  await deletion;
  const refreshed = await adminFetch("/applications");
  assert.ok(refreshed.ok);
  assert.equal(refreshed.data, "new");
  assert.equal(reads, 2);
});
