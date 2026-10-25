import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setImmediate } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import type { ReactElement, ReactNode } from "react";
import type { RepairActivityPublicView } from "../../src/features/repair-activities/repair-activity-service";
import { repairActivitiesPage } from "../../src/config/repair-activities";

const require = createRequire(import.meta.url);
const React = require("react") as typeof import("react");
type Props = { children?: ReactNode };
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (React.isValidElement<Props>(node)) return text(node.props.children);
  return typeof node === "string" ? node : "";
}

function findElement(
  node: ReactNode,
  predicate: (element: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, unknown>> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
  } else if (React.isValidElement<Record<string, unknown>>(node)) {
    if (predicate(node)) return node;
    return findElement(node.props.children as ReactNode, predicate);
  }
}

function signupDialog(node: ReactNode) {
  return findElement(node, (element) => typeof element.props.onConfirm === "function");
}
const activity: RepairActivityPublicView = {
  id: "a",
  title: "原活动",
  capacity: 10,
  registeredCount: 2,
  remaining: 8,
  activityAt: "2026-10-24T10:00:00Z",
  signupOpensAt: "2026-10-24T04:00:00Z",
  signupClosesAt: "2026-10-24T09:00:00Z",
  status: "UPCOMING",
};

/** 与既有客户端测试相同的 hook 存储方式；只驱动真实 JSX/effect，不启动 Next 或 DB。 */
async function mount(t: TestContext) {
  const originalCss = require.extensions[".css"];
  require.extensions[".css"] = (module) => {
    module.exports = {};
  };
  t.after(() => {
    if (originalCss) require.extensions[".css"] = originalCss;
    else delete require.extensions[".css"];
  });
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: new Date("2026-10-24T04:00:01Z") });
  (globalThis as unknown as { React: typeof React }).React = React;
  const originals = ["window", "document"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  const handlers = new Map<string, () => void>();
  const events = {
    addEventListener: (name: string, fn: () => void) => handlers.set(name, fn),
    removeEventListener: (name: string) => handlers.delete(name),
  };
  const document = { visibilityState: "visible", ...events };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { setInterval, clearInterval, ...events },
  });
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  const slots: unknown[] = [];
  const effects: { deps?: unknown[]; cleanup?: () => void }[] = [];
  const callbacks: { deps?: unknown[]; callback: unknown }[] = [];
  let cursor = 0,
    effectIndex = 0,
    callbackIndex = 0,
    id = "a";
  let pending: (() => void)[] = [];
  const changed = (old: unknown[] | undefined, next: unknown[] | undefined) =>
    !old ||
    !next ||
    old.length !== next.length ||
    old.some((value, i) => !Object.is(value, next[i]));
  t.mock.method(React, "useState", <S>(initial: S | (() => S)) => {
    const index = cursor++;
    if (!(index in slots))
      slots[index] = typeof initial === "function" ? (initial as () => S)() : initial;
    return [
      slots[index],
      (value: S | ((old: S) => S)) => {
        slots[index] =
          typeof value === "function" ? (value as (old: S) => S)(slots[index] as S) : value;
      },
    ];
  });
  t.mock.method(React, "useRef", <T>(initial: T) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = { current: initial };
    return slots[index];
  });
  t.mock.method(React, "useCallback", (callback: unknown, deps?: unknown[]) => {
    const index = callbackIndex++;
    if (!callbacks[index] || changed(callbacks[index].deps, deps))
      callbacks[index] = { deps, callback };
    return callbacks[index].callback;
  });
  t.mock.method(React, "useEffect", (effect: () => void | (() => void), deps?: unknown[]) => {
    const index = effectIndex++;
    const previous = effects[index];
    if (previous && !changed(previous.deps, deps)) return;
    pending.push(() => {
      previous?.cleanup?.();
      const cleanup = effect();
      effects[index] = { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
    });
  });
  const requests: {
    url: string;
    init: RequestInit;
    signal: AbortSignal;
    finish(response: Response): void;
  }[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    (url: string, init: RequestInit) =>
      new Promise<Response>((finish) => {
        requests.push({ url, init, signal: init.signal as AbortSignal, finish });
      }),
  );
  const { RepairActivityDetail } =
    await import("../../src/components/repair-activities/RepairActivityDetail");
  const view = () => {
    cursor = effectIndex = callbackIndex = 0;
    const node = RepairActivityDetail({ activityId: id });
    const queue = pending;
    pending = [];
    queue.forEach((run) => run());
    return node;
  };
  t.after(() => {
    effects.forEach((slot) => slot.cleanup?.());
    for (const [key, original] of originals) {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  view();
  let formResets = 0;
  return {
    view,
    requests,
    formResets: () => formResets,
    requestSignup() {
      const form = findElement(view(), (element) => element.props["aria-label"] === "报名参加");
      assert.ok(form);
      (form.props.ref as { current: unknown }).current = {
        reset() {
          formResets++;
        },
        focus() {},
      };
      t.mock.method(globalThis, "FormData", function () {
        return new Map([
          ["name", "测试客户"],
          ["phone", "13800000000"],
          ["issueType", "CLEAN_PASTE"],
          ["deviceModel", "测试机型"],
        ]);
      });
      (form.props.onSubmit as (event: unknown) => void)({
        preventDefault() {},
        currentTarget: {},
      });
      return signupDialog(view())!;
    },
    changeId(value: string) {
      id = value;
      view();
    },
    visibility(value: string) {
      document.visibilityState = value;
      handlers.get("visibilitychange")?.();
    },
    focus() {
      handlers.get("focus")?.();
    },
    async finish(index: number, data: RepairActivityPublicView | null) {
      requests[index].finish(
        data
          ? Response.json({ success: true, data })
          : Response.json({ success: false, error: { code: "INTERNAL_ERROR" } }, { status: 500 }),
      );
      await setImmediate();
    },
  };
}

test("活动轮询慢请求不叠加，隐藏时暂停，迟到响应与失败不覆盖已有内容", async (t) => {
  const ui = await mount(t);
  await ui.finish(0, activity);
  ui.view(); // 倒计时已归零，但服务端仍返回 UPCOMING，启动 30 秒复查。
  assert.equal(ui.requests.length, 2);
  t.mock.timers.tick(90_000);
  assert.equal(ui.requests.length, 2, "三个轮询节拍仍共用唯一在途请求");
  ui.visibility("hidden");
  assert.equal(ui.requests[1].signal.aborted, true);
  t.mock.timers.tick(90_000);
  assert.equal(ui.requests.length, 2);
  ui.visibility("visible");
  assert.equal(ui.requests.length, 3);
  await ui.finish(1, { ...activity, title: "已失效响应", status: "OPEN" });
  assert.equal(text(ui.view()).includes("已失效响应"), false);
  await ui.finish(2, null);
  assert.ok(text(ui.view()).includes("原活动"), "后台失败保留原内容");
  ui.focus();
  assert.equal(ui.requests.length, 4);
  await ui.finish(3, { ...activity, title: "最新活动", status: "OPEN" });
  assert.ok(text(ui.view()).includes("最新活动"));
  t.mock.timers.tick(60_000);
  assert.equal(ui.requests.length, 4, "状态已开放，停止等待开放的轮询");
});

test("切换活动会使旧请求失效，旧活动响应不能覆盖新目标", async (t) => {
  const ui = await mount(t);
  ui.changeId("b");
  assert.equal(ui.requests[0].signal.aborted, true);
  assert.equal(ui.requests[1].url, "/api/v1/repair-activities/b");
  await ui.finish(1, { ...activity, id: "b", title: "新目标", status: "OPEN" });
  await ui.finish(0, { ...activity, title: "旧目标", status: "OPEN" });
  const node: ReactElement = ui.view();
  assert.ok(text(node).includes("新目标"));
  assert.equal(text(node).includes("旧目标"), false);
});

test("完整须知可展开且提交前必须同意，成功只展示到场准备并且不重复提交", async (t) => {
  const ui = await mount(t);
  await ui.finish(0, { ...activity, status: "OPEN" });
  const panel = findElement(
    ui.view(),
    (element) => element.props["aria-labelledby"] === "repair-activity-precautions-title",
  );
  assert.ok(panel);
  const { RepairActivityPrecautions } =
    await import("../../src/components/repair-activities/RepairActivityPrecautions");
  const { RepairActivityPreparation } =
    await import("../../src/components/repair-activities/RepairActivityPreparation");
  assert.ok(findElement(panel, (element) => element.type === RepairActivityPreparation));
  const fullNotice = findElement(panel, (element) => element.type === "details");
  assert.ok(fullNotice);
  assert.equal(fullNotice.props.open, undefined, "默认折叠完整须知");
  assert.ok(findElement(fullNotice, (element) => element.type === RepairActivityPrecautions));
  assert.equal(
    text(RepairActivityPrecautions()),
    repairActivitiesPage.detail.consent.clauses.join(""),
  );

  const consent = ui.requestSignup();
  assert.equal(ui.requests.length, 1, "未同意须知时不发送报名请求");
  assert.equal(consent.props.title, repairActivitiesPage.detail.consent.title);
  assert.equal(consent.props.confirmLabel, repairActivitiesPage.detail.consent.agree);
  assert.ok(findElement(consent, (element) => element.type === RepairActivityPrecautions));
  (consent.props.onConfirm as () => void)();
  assert.equal(signupDialog(ui.view())?.props.busy, true);
  assert.deepEqual(JSON.parse(ui.requests[1].init.body as string), {
    name: "测试客户",
    phone: "13800000000",
    issueType: "CLEAN_PASTE",
    deviceModel: "测试机型",
    consentAccepted: true,
  });
  ui.requests[1].finish(Response.json({ success: true }));
  await setImmediate();
  let success = signupDialog(ui.view());
  assert.equal(success?.props.title, repairActivitiesPage.detail.signupSuccessTitle);
  assert.equal(success?.props.cancelLabel, undefined);
  assert.equal(ui.formResets(), 1, "成功后清空报名表单");
  assert.equal(
    findElement(success, (element) => element.type === RepairActivityPrecautions),
    undefined,
  );
  assert.ok(findElement(success, (element) => element.type === RepairActivityPreparation));
  for (const item of repairActivitiesPage.detail.preparation) {
    assert.ok(text(RepairActivityPreparation()).includes(item.title));
  }

  await ui.finish(2, null); // 成功后的刷新失败不能覆盖成功提醒。
  success = signupDialog(ui.view());
  assert.equal(success?.props.title, repairActivitiesPage.detail.signupSuccessTitle);
  (success?.props.onConfirm as () => void)();
  assert.equal(signupDialog(ui.view()), undefined);
  assert.equal(ui.requests.filter((request) => request.init.method === "POST").length, 1);
});

test("报名失败只显示错误，保留输入以便重试，不显示成功提醒", async (t) => {
  const ui = await mount(t);
  await ui.finish(0, { ...activity, status: "OPEN" });
  const consent = ui.requestSignup();
  (consent.props.onConfirm as () => void)();
  ui.requests[1].finish(
    Response.json({ success: false, error: { message: "名额已满" } }, { status: 409 }),
  );
  await setImmediate();
  assert.equal(signupDialog(ui.view()), undefined);
  assert.ok(text(ui.view()).includes("名额已满"));
  assert.equal(ui.formResets(), 0, "失败时保留已填写的表单");
  assert.equal(ui.requests.length, 2, "失败时不刷新活动或再次提交");
  assert.equal(ui.requestSignup().props.title, repairActivitiesPage.detail.consent.title);
});

test("上次报名的慢刷新结束时，不解除下一次报名的在途禁用", async (t) => {
  const ui = await mount(t);
  await ui.finish(0, { ...activity, status: "OPEN" });
  (ui.requestSignup().props.onConfirm as () => void)();
  ui.requests[1].finish(Response.json({ success: true }));
  await setImmediate();
  assert.equal(ui.requests[2].init.method, undefined, "首次报名成功后刷新活动");
  (signupDialog(ui.view())?.props.onConfirm as () => void)();

  (ui.requestSignup().props.onConfirm as () => void)();
  assert.equal(ui.requests[3].init.method, "POST");
  assert.equal(signupDialog(ui.view())?.props.busy, true);
  await ui.finish(2, { ...activity, status: "OPEN", registeredCount: 3, remaining: 7 });
  assert.equal(signupDialog(ui.view())?.props.busy, true, "旧 GET 不能解锁仍在提交的新报名");
  const name = findElement(ui.view(), (element) => element.props.name === "name");
  assert.equal(name?.props.disabled, true);

  ui.requests[3].finish(Response.json({ success: true }));
  await setImmediate();
  assert.equal(
    signupDialog(ui.view())?.props.title,
    repairActivitiesPage.detail.signupSuccessTitle,
  );
  assert.equal(signupDialog(ui.view())?.props.busy, false);
  await ui.finish(4, null);
});
