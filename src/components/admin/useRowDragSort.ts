"use client";

import { useCallback, useRef, useState, type DragEvent, type KeyboardEvent } from "react";

import { movingRowIds } from "@/lib/list-order";

/** 仅手柄触发拖动，落点按行的上半 / 下半判断；多选行整块移动，落点跳过被移动行。键盘与触屏保留上移 / 下移入口。 */
export type DropTarget = { id: string; after: boolean };

export function useRowDragSort(
  ids: readonly string[],
  onDropRow: (id: string, beforeId: string | null) => void,
  /**
   * 当前勾选的 id（可空）。勾了多行时拖动其中一行 = 整块移动，`rowClass` 也会把
   * 整块标成 `is-dragging`，让用户看清「拖的是这几行」。
   */
  selection: readonly string[] = [],
) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  /**
   * 正在拖动的那一行，**同步**记在 ref 里。
   *
   * 不能只靠 state：`dragstart` 里 setState 之后，React 要到下一次渲染才把
   * 新的闭包交给事件处理器；真实拖动时两次事件之间隔着用户的鼠标移动，状态早就提交了，
   * 所以「用 state 判断」平时看不出问题 —— 但同一帧里连续派发 dragstart / dragover
   * （自动化验证里就是这样）时，dragover 拿到的仍是 `draggingId === null` 的旧闭包，
   * 于是整条链静默失效。落点判断是逻辑，逻辑用 ref；`draggingId` state 只负责样式。
   */
  const draggingRef = useRef<string | null>(null);

  /**
   * 落点参照行：从悬停行按方向找到**第一行不在移动集合里**的行；找不到就是末尾（`null`）。
   *
   * 为什么要跳过移动集合：勾选三行后拖其中一行，鼠标必然先掠过这三行自己。
   * 不跳过的话落点会解析成「插到自己前面」= 原地不动，用户看到的就是「拖不动」。
   */
  const referenceId = useCallback(
    (hoveredId: string, after: boolean) => {
      const moving = new Set(movingRowIds(draggingRef.current ?? "", selection));
      const start = ids.indexOf(hoveredId) + (after ? 1 : 0);
      for (let index = Math.max(0, start); index < ids.length; index += 1) {
        if (!moving.has(ids[index])) return ids[index];
      }
      return null;
    },
    [ids, selection],
  );

  const reset = useCallback(() => {
    draggingRef.current = null;
    setDraggingId(null);
    setDropTarget(null);
  }, []);

  /** 手柄：唯一 `draggable` 的元素。 */
  const handleProps = useCallback(
    (id: string) => ({
      draggable: true,
      onDragStart: (event: DragEvent<HTMLElement>) => {
        event.dataTransfer.effectAllowed = "move";
        // Firefox 要求必须 setData 才会真正开始拖动。
        event.dataTransfer.setData("text/plain", id);
        const row = event.currentTarget.closest("tr");
        if (row) {
          try {
            event.dataTransfer.setDragImage(row, 16, 12);
          } catch {
            // 合成事件（自动化验证）里 setDragImage 可能抛 InvalidStateError：
            // 拖动图示只是观感，拿不到就退回默认图示，不影响排序。
          }
        }
        draggingRef.current = id;
        setDraggingId(id);
      },
      onDragEnd: reset,
    }),
    [reset],
  );

  /** 行：接收落点。 */
  const rowProps = useCallback(
    (id: string) => ({
      onDragOver: (event: DragEvent<HTMLTableRowElement>) => {
        const dragging = draggingRef.current;
        if (!dragging || dragging === id) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const rect = event.currentTarget.getBoundingClientRect();
        const after = event.clientY > rect.top + rect.height / 2;
        setDropTarget((current) =>
          current?.id === id && current.after === after ? current : { id, after },
        );
      },
      onDragLeave: (event: DragEvent<HTMLTableRowElement>) => {
        // 只在真正离开这一行时清掉：行列内部的子元素会各自触发 dragleave，
        // 不判断 relatedTarget 的话指示线会一直闪。
        const next = event.relatedTarget as Node | null;
        if (next && event.currentTarget.contains(next)) return;
        setDropTarget((current) => (current?.id === id ? null : current));
      },
      onDrop: (event: DragEvent<HTMLTableRowElement>) => {
        const dragging = draggingRef.current;
        if (!dragging) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        const after = event.clientY > rect.top + rect.height / 2;
        const beforeId = referenceId(id, after);
        reset();
        // 落点就是自己（单行拖动、位置没变）时什么都不做；多行时由服务端与本地规则
        // 判定「顺序没变即幂等」。
        if (beforeId !== dragging) onDropRow(dragging, beforeId);
      },
    }),
    [onDropRow, referenceId, reset],
  );

  /**
   * 键盘路径（可选）：手柄可聚焦，↑ / ↓ 把这一行挪一格。
   *
   * 只有**没有 ↑↓ 按钮的表格**才需要它（成员表把操作列撤掉之后就没有按钮了）；
   * 技能 / 故障分类已经有每行的 ↑ ↓，不需要再挂这个，所以它跟 `handleProps` 分开，
   * 由调用方自己决定要不要展开。
   */
  const keyboardProps = useCallback(
    (id: string) => ({
      role: "button" as const,
      tabIndex: 0,
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        const index = ids.indexOf(id);
        if (index < 0) return;
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        // 整块移动一格：参照行同样跳过移动集合，否则块内的行会把落点顶回原位。
        const beforeId = referenceId(id, event.key === "ArrowDown");
        if (beforeId === id) return;
        onDropRow(id, beforeId);
        event.preventDefault();
      },
    }),
    [ids, onDropRow, referenceId],
  );

  /** 行的附加类名：正在拖的行半透明，落点行画一条指示线。 */
  const rowClass = useCallback(
    (id: string) => {
      const classes: string[] = [];
      // 整块一起标成「正在拖动」：勾选三行拖其中一行时，用户要能看出走的是哪几行。
      const moving = draggingId ? movingRowIds(draggingId, selection) : [];
      if (moving.includes(id)) classes.push("is-dragging");
      if (dropTarget?.id === id)
        classes.push(dropTarget.after ? "is-drop-after" : "is-drop-before");
      return classes.join(" ");
    },
    [draggingId, dropTarget, selection],
  );

  return { draggingId, dropTarget, handleProps, keyboardProps, rowProps, rowClass };
}
