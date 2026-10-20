import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { POST } from "../../src/app/api/v1/bot/repair-activities/route";
import { GET, PATCH } from "../../src/app/api/v1/bot/repair-activities/[id]/route";
import { GET as operationGET } from "../../src/app/api/v1/bot/operations/[id]/route";
import { repairActivityService } from "../../src/features/repair-activities/repair-activity-service";
import { disconnectDb, getDb } from "../../src/lib/db/client";
import type { AuthorizedActor } from "../../src/types/contracts";
import { integrationTestsEnabled } from "./db-guard";

const enabled = integrationTestsEnabled();
const dbTest = enabled ? test : test.skip;
const prefix = "MGMT20261020 ";
const userId = randomUUID();
const operationIds: string[] = [];
const token = "integration_machine_" + "x".repeat(48);
const origin = "test:GroupMessage:management";
process.env.MANAGEMENT_BOT_TOKEN_SHA256 = createHash("sha256").update(token).digest("hex");
process.env.MANAGEMENT_BOT_TOKEN_EXPIRES_AT = "2099-01-01T00:00:00Z";
process.env.MANAGEMENT_BOT_ORIGIN = origin;
const headers = {
  authorization: `Bearer ${token}`,
  "x-management-origin": origin,
  "x-management-actor": "A".repeat(32),
  "content-type": "application/json",
};
const admin: AuthorizedActor = {
  actorType: "USER",
  userId,
  userStatus: "ACTIVE",
  permissions: ["activity:admin"],
  requestId: "management-test-admin",
};
const body = {
  title: prefix + "合成活动",
  capacity: 10,
  activityAt: "2090-11-01T18:00:00+08:00",
  signupOpensAt: "2090-10-21T10:00:00+08:00",
  signupClosesAt: "2090-10-31T18:00:00+08:00",
};
function operation() {
  const id = randomUUID();
  operationIds.push(id);
  return id;
}
function request(method: string, payload?: unknown, extra: Record<string, string> = {}) {
  return new Request("http://localhost/api/v1/bot/repair-activities", {
    method,
    headers: { ...headers, ...extra },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });
}
const context = (id: string) => ({ params: Promise.resolve({ id }) });
async function create(id = operation()) {
  const response = await POST(request("POST", body, { "idempotency-key": id }));
  assert.equal(response.status, 201);
  return { response, result: (await response.json()).data, operationId: id };
}

before(async () => {
  if (!enabled) return;
  await getDb().user.create({ data: { id: userId, status: "ACTIVE", createdAt: new Date() } });
});
after(async () => {
  if (!enabled) return;
  const db = getDb();
  const rows = await db.repairActivity.findMany({
    where: { title: { startsWith: prefix } },
    select: { id: true },
  });
  const ids = rows.map((r) => r.id);
  await db.auditLog.deleteMany({
    where: { OR: [{ targetId: { in: ids } }, { actorUserId: userId }] },
  });
  await db.repairActivityRegistration.deleteMany({ where: { activityId: { in: ids } } });
  await db.repairActivity.deleteMany({ where: { id: { in: ids } } });
  await db.botOperation.deleteMany({
    where: { principalId: "management-whale", operationId: { in: operationIds } },
  });
  await db.user.delete({ where: { id: userId } });
  await disconnectDb();
});

dbTest(
  "machine create commits SYSTEM audit and safe response with no fabricated user",
  async () => {
    const { result } = await create();
    assert.equal(result.version, '"1"');
    assert.equal(result.createdBy, undefined);
    assert.equal(result.attendedCount, undefined);
    const row = await getDb().repairActivity.findUniqueOrThrow({ where: { id: result.id } });
    assert.equal(row.createdBy, null);
    const audit = await getDb().auditLog.findFirstOrThrow({ where: { targetId: result.id } });
    assert.equal(audit.actorType, "SYSTEM");
    assert.equal(audit.actorUserId, null);
    assert.ok(JSON.stringify(audit.afterSummary).includes("management-whale"));
  },
);

dbTest(
  "same operation concurrent/repeated creates return one activity; changed body conflicts",
  async () => {
    const id = operation();
    const [a, b] = await Promise.all([create(id), create(id)]);
    assert.equal(a.result.id, b.result.id);
    const response = await POST(
      request("POST", { ...body, capacity: 11 }, { "idempotency-key": id }),
    );
    assert.equal(response.status, 409);
    assert.equal(await getDb().repairActivity.count({ where: { id: a.result.id } }), 1);
    assert.equal(
      await getDb().botOperation.count({
        where: { principalId: "management-whale", operationId: id },
      }),
      1,
    );
  },
);

dbTest(
  "version check covers ordinary admin updates and ABA, not just machine updates",
  async () => {
    const { result } = await create();
    const detail = await GET(request("GET"), context(result.id));
    assert.equal(detail.headers.get("etag"), '"1"');
    const id = operation();
    const patch = await PATCH(
      request("PATCH", { capacity: 12 }, { "idempotency-key": id, "if-match": '"1"' }),
      context(result.id),
    );
    assert.equal(patch.status, 200);
    assert.equal((await patch.json()).data.version, '"2"');
    const replayed = await PATCH(
      request("PATCH", { capacity: 12 }, { "idempotency-key": id, "if-match": '"1"' }),
      context(result.id),
    );
    assert.equal(replayed.status, 200);
    assert.equal((await replayed.json()).data.version, '"2"');
    await repairActivityService.update(result.id, { title: prefix + "临时改名" }, admin);
    await repairActivityService.update(result.id, { title: body.title }, admin);
    const staleOp = operation();
    const stale = await PATCH(
      request("PATCH", { capacity: 20 }, { "idempotency-key": staleOp, "if-match": '"2"' }),
      context(result.id),
    );
    assert.equal(stale.status, 409);
    const row = await getDb().repairActivity.findUniqueOrThrow({ where: { id: result.id } });
    assert.equal(row.version, 4);
    assert.equal(row.capacity, 12);
    assert.equal(await getDb().botOperation.count({ where: { operationId: staleOp } }), 0);
  },
);

dbTest("unsupported fields and invalid business times leave zero partial write", async () => {
  const id = operation();
  const response = await POST(
    request(
      "POST",
      { ...body, signupClosesAt: "2091-01-01T18:00:00+08:00" },
      { "idempotency-key": id },
    ),
  );
  assert.equal(response.status, 400);
  assert.equal(await getDb().botOperation.count({ where: { operationId: id } }), 0);
  const { result } = await create();
  const before = await getDb().repairActivity.findUniqueOrThrow({ where: { id: result.id } });
  const patch = await PATCH(
    request(
      "PATCH",
      { signupClosesAt: body.signupClosesAt },
      { "idempotency-key": operation(), "if-match": '"1"' },
    ),
    context(result.id),
  );
  assert.equal(patch.status, 400);
  assert.deepEqual(
    await getDb().repairActivity.findUniqueOrThrow({ where: { id: result.id } }),
    before,
  );
});

dbTest(
  "capacity cannot fall below registered count and rejected operation is rolled back",
  async () => {
    const { result } = await create();
    await getDb().repairActivityRegistration.createMany({
      data: [1, 2].map((n) => ({
        id: randomUUID(),
        activityId: result.id,
        name: `合成报名${n}`,
        phone: `1390000000${n}`,
        phoneLast4: `000${n}`,
        issueType: "SYSTEM",
        status: "REGISTERED",
        createdAt: new Date(),
      })),
    });
    const operationId = operation();
    const response = await PATCH(
      request("PATCH", { capacity: 1 }, { "idempotency-key": operationId, "if-match": '"1"' }),
      context(result.id),
    );
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "ACTIVITY_CAPACITY_TOO_LOW");
    assert.equal(await getDb().botOperation.count({ where: { operationId } }), 0);
    assert.equal(
      (await getDb().repairActivity.findUniqueOrThrow({ where: { id: result.id } })).version,
      1,
    );
  },
);

dbTest(
  "operation lookup retrieves committed outcome; scoped actor cannot read registrants",
  async () => {
    const { result, operationId } = await create();
    const r = await operationGET(request("GET"), context(operationId));
    assert.equal(r.status, 200);
    assert.equal((await r.json()).data.result.id, result.id);
    await assert.rejects(
      repairActivityService.listRegistrations(result.id, {
        actorType: "SYSTEM",
        userStatus: "ACTIVE",
        permissions: [],
        requestId: "machine",
      }),
      { code: "FORBIDDEN" },
    );
  },
);
