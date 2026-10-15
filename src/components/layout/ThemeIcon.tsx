"use client";

import { useSyncExternalStore } from "react";

import { resolveTheme } from "@/config/theme";
import { getServerThemeModeSnapshot, getThemeModeSnapshot, subscribeThemeMode } from "@/lib/theme";

/** 与显示模式共用同一快照，由 React 更新图标，避免 hydration 重复插入。 */
export function ThemeIcon() {
  const mode = useSyncExternalStore(
    subscribeThemeMode,
    getThemeModeSnapshot,
    getServerThemeModeSnapshot,
  );

  return <link rel="icon" href={resolveTheme(mode).iconHref} type="image/svg+xml" sizes="any" />;
}
