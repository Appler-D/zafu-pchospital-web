"use client";

import { useCallback, useRef, type ChangeEvent } from "react";

/** 行勾选与 Shift 范围选择；拖动排序由 useRowDragSort 处理。 */
export function useRowSelect({
  ids,
  selected,
  onChange,
}: {
  /** 当前已渲染的行 id，顺序与界面一致。 */
  ids: string[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  /** 范围选择的锚点：上一次单独点过的行。 */
  const anchor = useRef<string | null>(null);

  /** 点序号 / 复选框：普通点击切换单行，`Shift` 点击选中两行之间的一段。 */
  const checkboxProps = useCallback(
    (id: string) => ({
      className: "admin-check admin-rownum__box",
      type: "checkbox" as const,
      checked: selected.includes(id),
      onChange: (event: ChangeEvent<HTMLInputElement>) => {
        const checked = event.currentTarget.checked;
        // `ChangeEvent` 上没有 `shiftKey`，底层事件（点击触发的 change）是 MouseEvent。
        const shiftKey = (event.nativeEvent as MouseEvent).shiftKey === true;
        if (shiftKey && anchor.current) {
          const from = ids.indexOf(anchor.current);
          const to = ids.indexOf(id);
          if (from >= 0 && to >= 0) {
            const range = ids.slice(Math.min(from, to), Math.max(from, to) + 1);
            onChange(
              checked
                ? [...new Set([...selected, ...range])]
                : selected.filter((item) => !range.includes(item)),
            );
            return;
          }
        }
        anchor.current = id;
        onChange(checked ? [...selected, id] : selected.filter((item) => item !== id));
      },
    }),
    [ids, onChange, selected],
  );

  return { checkboxProps, anchor };
}
