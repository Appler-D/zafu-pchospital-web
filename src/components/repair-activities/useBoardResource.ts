"use client";

import { useEffect, useRef, useState } from "react";
import { createBoardReader } from "./board-reader";

export function useBoardResource<T>(
  activityId: string,
  view: "live" | "served" | "attendance",
  options: { automatic: boolean; paused: boolean; interval: number; succeeded?: (data: T) => void },
) {
  const [, render] = useState(0);
  const settings = useRef(options);
  settings.current = options;
  const slot = useRef<{ id: string; reader: ReturnType<typeof createBoardReader<T>> } | null>(null);
  if (!slot.current || slot.current.id !== activityId) {
    slot.current?.reader.dispose();
    slot.current = {
      id: activityId,
      reader: createBoardReader<T>({
        url: `/api/v1/member/repair-activities/${activityId}/board?view=${view}`,
        interval: () => settings.current.interval,
        paused: () => settings.current.paused,
        changed: () => render((value) => value + 1),
        succeeded: (data) => settings.current.succeeded?.(data),
      }),
    };
  }
  const reader = slot.current.reader;
  useEffect(() => {
    // Strict Mode 的 setup/cleanup 会复用实例；清理只失效请求，不把实例永久关闭。
    return () => reader.invalidate();
  }, [reader]);
  useEffect(() => {
    if (!options.automatic || options.paused) {
      reader.invalidate(true);
      return;
    }
    const refresh = () => {
      if (document.visibilityState !== "visible") reader.invalidate(true);
      else void reader.read({ resume: true });
    };
    refresh();
    const timer = window.setInterval(() => void reader.read(), 1_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      reader.invalidate(true);
    };
  }, [reader, options.automatic, options.paused, options.interval]);
  return reader;
}
