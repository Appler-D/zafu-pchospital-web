import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { authenticateMachine } from "../../src/lib/auth/machine";
import {
  parseCreate,
  parseUpdate,
  parseVersion,
  requireUuid,
  operationDigest,
  readMachineBody,
} from "../../src/features/management/management-input";
import { POST } from "../../src/app/api/v1/bot/repair-activities/route";

const token = "test_machine_" + "a".repeat(48);
const origin = "test:GroupMessage:management";
process.env.MANAGEMENT_BOT_TOKEN_SHA256 = createHash("sha256").update(token).digest("hex");
process.env.MANAGEMENT_BOT_TOKEN_EXPIRES_AT = "2099-01-01T00:00:00Z";
process.env.MANAGEMENT_BOT_ORIGIN = origin;
const headers = {
  authorization: `Bearer ${token}`,
  "x-management-origin": origin,
  "x-management-actor": "A".repeat(32),
};

test("machine auth maps a fixed SYSTEM principal with no user or ADMIN rights", () => {
  const actor = authenticateMachine(
    new Request("http://localhost", { headers }),
    "test",
    "activity:create",
  );
  assert.equal(actor.actorType, "SYSTEM");
  assert.equal(actor.userId, undefined);
  assert.deepEqual(actor.permissions, []);
  assert.equal(actor.principalId, "management-whale");
  for (const change of [
    { authorization: "Bearer wrong" },
    { authorization: "" },
    { "x-management-origin": "another-group" },
    { "x-management-actor": "some-admin" },
  ]) {
    assert.throws(() =>
      authenticateMachine(
        new Request("http://localhost", { headers: { ...headers, ...change } }),
        "test",
        "activity:create",
      ),
    );
  }
});

test("missing/expired machine configuration denies access, even with an admin Cookie", async () => {
  const configured = process.env.MANAGEMENT_BOT_TOKEN_SHA256;
  process.env.MANAGEMENT_BOT_TOKEN_SHA256 = "";
  assert.throws(() =>
    authenticateMachine(new Request("http://localhost", { headers }), "t", "activity:read"),
  );
  process.env.MANAGEMENT_BOT_TOKEN_SHA256 = configured;
  process.env.MANAGEMENT_BOT_TOKEN_EXPIRES_AT = "2000-01-01T00:00:00Z";
  assert.throws(() =>
    authenticateMachine(new Request("http://localhost", { headers }), "t", "activity:read"),
  );
  process.env.MANAGEMENT_BOT_TOKEN_EXPIRES_AT = "2099-01-01T00:00:00Z";
  const response = await POST(
    new Request("http://localhost/api/v1/bot/repair-activities", {
      method: "POST",
      headers: { cookie: "pc_hospital_session=not-a-machine-token" },
      body: "{}",
    }),
  );
  assert.equal(response.status, 401);
});

test("machine inputs reject unsupported fields, guessed versions and ambiguous timezones", () => {
  const create = {
    title: "周末义修",
    capacity: 20,
    activityAt: "2026-11-01T18:00:00+08:00",
    signupOpensAt: "2026-10-21T10:00:00+08:00",
    signupClosesAt: "2026-10-31T18:00:00+08:00",
  };
  assert.equal(parseCreate(create).capacity, 20);
  assert.throws(() => parseCreate({ ...create, capacity: true }));
  assert.throws(() => parseCreate({ ...create, activityAt: "2026-11-01T18:00:00" }));
  assert.throws(() => parseCreate({ ...create, createdBy: "admin" }));
  assert.deepEqual(parseUpdate({ capacity: 30 }), { capacity: 30 });
  for (const input of [{}, { activityAt: create.activityAt }, { deletedAt: "now" }])
    assert.throws(() => parseUpdate(input));
  assert.equal(parseVersion('"12"'), 12);
  for (const v of [null, "*", "12", '"1", "2"', '"-1"']) assert.throws(() => parseVersion(v));
  assert.equal(
    requireUuid("F0000000-0000-4000-8000-000000000001"),
    "f0000000-0000-4000-8000-000000000001",
  );
  assert.throws(() => requireUuid("../../admin"));
});

test("idempotency digest is stable across field order, but changes with content/version", () => {
  assert.equal(operationDigest({ a: 1, b: 2 }), operationDigest({ b: 2, a: 1 }));
  assert.notEqual(operationDigest({ a: 1 }), operationDigest({ a: 2 }));
  assert.notEqual(operationDigest({ version: 1 }), operationDigest({ version: 2 }));
});

test("machine JSON input remains bounded and rejects malformed objects", async () => {
  const request = (body: string) =>
    new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  assert.deepEqual(await readMachineBody(request('{"title":"义修"}')), { title: "义修" });
  for (const body of ["[]", "{", '"text"', "x".repeat(9000)])
    await assert.rejects(readMachineBody(request(body)));
});
