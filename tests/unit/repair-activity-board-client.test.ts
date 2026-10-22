import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setImmediate } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import type { ReactElement, ReactNode } from "react";
import { memberRepairActivitiesCopy } from "../../src/config/repair-activities";
import type {
  StaffBoardView,
  StaffRegistrationView,
} from "../../src/features/repair-activities/repair-activity-staff-service";

const require = createRequire(import.meta.url);
const React = require("react") as typeof import("react");
const { AppRouterContext } = require("next/dist/shared/lib/app-router-context.shared-runtime");
const copy = memberRepairActivitiesCopy.board;
const end = new Date("2026-10-23T16:00:00.000Z");
type Props = {
  children?: ReactNode;
  disabled?: boolean;
  checked?: boolean;
  type?: string;
  className?: string;
  message?: string;
  title?: string;
  busy?: boolean;
  confirmDisabled?: boolean;
  onClick?: () => void;
  onChange?: () => void;
  onConfirm?: () => void;
  onClose?: () => void;
};
function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement<Props>(node)) return [];
  return [node, ...elements(node.props.children)];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (React.isValidElement<Props>(node)) return text(node.props.children);
  return typeof node === "string" ? node : "";
}
const row: StaffRegistrationView = {
  id: "registration",
  activityId: "activity",
  name: "隔离夹具",
  phoneMasked: "139****0000",
  issueType: "CLEAN_ONLY",
  issueTypeLabel: "清灰",
  deviceModel: null,
  status: "REGISTERED",
  checkedInAt: null,
  servedAt: null,
  repairRecordId: null,
  createdAt: "2026-10-23T00:00:00Z",
};
function board(attended = true): StaffBoardView {
  return {
    activity: {
      id: "activity",
      title: "隔离活动",
      activityAt: "2026-10-23T10:30:00Z",
      capacity: 10,
      signupOpensAt: "2026-10-22T00:00:00Z",
      signupClosesAt: "2026-10-23T04:00:00Z",
      status: "CLOSED",
      registeredCount: 3,
      remaining: 7,
      attended,
    },
    attended,
    attendanceCheckedInAt: attended ? "2026-10-23T05:00:00Z" : null,
    canAdmin: true,
    attendanceMembers: [],
    eligible: [row],
    queue: [{ ...row, id: "queue", status: "CHECKED_IN", checkedInAt: "2026-10-23T05:00:00Z" }],
    served: [
      {
        ...row,
        id: "served",
        status: "SERVED",
        repairRecordId: "draft",
        recordStatus: "DRAFT",
        canRevert: true,
      },
    ],
    pendingServeDraft: null,
  };
}

/** 复用已有客户端测试的 Node hook 装置，运行真实看板 JSX 和事件；不启动浏览器或 DB。 */
async function mount(t: TestContext, data: StaffBoardView, now: Date, rejectEnded = false) {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now });
  const originals = ["window", "document"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setInterval,
      clearInterval,
      scrollX: 0,
      scrollY: 0,
      addEventListener() {},
      removeEventListener() {},
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      visibilityState: "visible",
      addEventListener() {},
      removeEventListener() {},
    },
  });
  (globalThis as unknown as { React: typeof React }).React = React;
  const slots: unknown[] = [];
  const effectSlots: { deps?: unknown[]; cleanup?: () => void }[] = [];
  const pendingEffects: { index: number; effect: () => void | (() => void) }[] = [];
  const callbackSlots: { deps?: unknown[]; callback: unknown }[] = [];
  let cursor = 0,
    effectCursor = 0,
    callbackCursor = 0,
    mounted = false;
  const depsChanged = (previous: unknown[] | undefined, next: unknown[] | undefined) =>
    !previous ||
    !next ||
    previous.length !== next.length ||
    previous.some((value, index) => !Object.is(value, next[index]));
  const runEffect = (effect: () => void | (() => void)): (() => void) | undefined => {
    const cleanup = effect();
    return typeof cleanup === "function" ? cleanup : undefined;
  };
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
  t.mock.method(React, "useEffect", (effect: () => void | (() => void), deps?: unknown[]) => {
    const index = effectCursor++;
    if (!mounted) {
      effectSlots[index] = { deps };
      pendingEffects.push({ index, effect });
      return;
    }
    const previous = effectSlots[index];
    if (previous && !depsChanged(previous.deps, deps)) return;
    previous?.cleanup?.();
    effectSlots[index] = { deps, cleanup: runEffect(effect) };
  });
  t.mock.method(React, "useLayoutEffect", () => {});
  t.mock.method(React, "useCallback", (callback: unknown, deps?: unknown[]) => {
    const index = callbackCursor++;
    if (!callbackSlots[index] || depsChanged(callbackSlots[index].deps, deps))
      callbackSlots[index] = { deps, callback };
    return callbackSlots[index].callback;
  });
  t.mock.method(React, "useContext", (context: unknown) => {
    assert.equal(context, AppRouterContext);
    return { push() {}, refresh() {} };
  });
  const posts: string[] = [];
  let gets = 0;
  t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push(String(input));
      assert.ok(rejectEnded, "截止后不能发出写请求");
      return Response.json(
        { success: false, error: { code: "ACTIVITY_ENDED", message: "server" } },
        { status: 404 },
      );
    }
    gets += 1;
    return Response.json({ success: true, data });
  });
  const { MemberRepairActivityBoard } =
    await import("../../src/components/repair-activities/MemberRepairActivityBoard");
  const view = () => {
    cursor = 0;
    effectCursor = 0;
    callbackCursor = 0;
    return MemberRepairActivityBoard({ activityId: "activity" });
  };
  view();
  mounted = true;
  for (const { index, effect } of pendingEffects) {
    effectSlots[index].cleanup = runEffect(effect);
  }
  t.after(() => {
    for (const slot of effectSlots) slot.cleanup?.();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  await setImmediate();
  function button(label: string) {
    const found = elements(view()).find(
      (element) => typeof element.type !== "string" && element.props.children === label,
    );
    assert.ok(found, `Missing button: ${label}`);
    return found.props;
  }
  function dialog() {
    return elements(view()).find((element) => element.props.title === copy.checkInConfirmTitle)
      ?.props;
  }
  return { view, button, dialog, posts, gets: () => gets, elements: () => elements(view()) };
}

test("结束的看板保留历史、出勤状态和纠错，三项控件禁用且不误报尚未截止", async (t) => {
  const data = board(false);
  const ui = await mount(t, data, end);
  assert.equal(ui.button(copy.attendCta).disabled, true);
  assert.equal(ui.button(copy.checkIn).disabled, true);
  assert.equal(ui.button(copy.serve).disabled, true);
  assert.equal(
    ui.elements().find((element) => element.props.type === "checkbox")?.props.disabled,
    true,
  );
  assert.ok(text(ui.view()).includes(copy.activityEnded));
  assert.equal(text(ui.view()).includes(copy.signupNotClosed), false);
  data.attended = true;
  t.mock.timers.tick(5_000);
  await setImmediate();
  assert.ok(text(ui.view()).includes(copy.attendedBadge));
  assert.equal(ui.button(copy.withdraw).disabled, false);
  assert.equal(ui.button(copy.revertServe).disabled, undefined);
  assert.equal(
    ui
      .elements()
      .some(
        (element) =>
          element.props.className === "activity-board__panes activity-board__panes--admin",
      ),
    true,
  );
  assert.deepEqual(ui.posts, []);
});

test("旧签到确认窗跨过结束上限不能提交，取消仍可用，既有看板不卸载", async (t) => {
  const ui = await mount(t, board(), new Date(end.getTime() - 1_000));
  ui.elements().find((element) => element.props.type === "checkbox")!.props.onChange!();
  ui.button(copy.checkIn).onClick!();
  const oldConfirm = ui.dialog()!;
  assert.equal(oldConfirm.confirmDisabled, false);
  // 不等真实午夜，也不依赖轮询先触发：旧事件处理器自己必须重查当前时间。
  t.mock.timers.tick(1_001);
  oldConfirm.onConfirm!();
  assert.deepEqual(ui.posts, []);
  assert.equal(ui.dialog()!.confirmDisabled, true);
  assert.equal(ui.dialog()!.busy, false);
  assert.equal(
    ui.elements().some((element) => element.props.className === "activity-board__attend-banner"),
    false,
    "截止反馈不能插入占位卡片",
  );
  assert.equal(
    ui.elements().some((element) => element.props.message === copy.activityEnded),
    true,
  );
  ui.dialog()!.onClose!();
  assert.equal(ui.dialog(), undefined);
  assert.equal(ui.button(copy.withdraw).disabled, false);
});

test("服务端先判定结束时保留看板并禁用操作，不伪报出勤成功或自动重试", async (t) => {
  const ui = await mount(t, board(false), new Date(end.getTime() - 60_000), true);
  ui.button(copy.attendCta).onClick!();
  await setImmediate();
  assert.equal(ui.posts.length, 1);
  assert.equal(ui.button(copy.attendCta).disabled, true);
  assert.equal(ui.button(copy.serve).disabled, true);
  assert.ok(text(ui.view()).includes(copy.activityEnded));
  assert.equal(text(ui.view()).includes(copy.attendedBadge), false);
});

test("结束后轮询节拍降为 60 秒，历史看板保留", async (t) => {
  const data = board(true);
  data.activity.status = "ENDED";
  const ui = await mount(t, data, end);
  // 初次加载判定结束后 effect 依赖变化会重建节拍；先让重建后的首轮刷新落定。
  ui.view();
  await setImmediate();
  const baseline = ui.gets();
  t.mock.timers.tick(5_000);
  await setImmediate();
  assert.equal(ui.gets(), baseline, "结束后不再按 5 秒节拍取数");
  t.mock.timers.tick(60_000);
  await setImmediate();
  assert.ok(ui.gets() > baseline, "60 秒节拍恢复刷新");
  assert.equal(
    ui.elements().some((element) => element.props.message === copy.activityEnded),
    true,
  );
});
