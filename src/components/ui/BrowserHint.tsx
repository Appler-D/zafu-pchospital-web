"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Icon } from "@/components/ui/Icon";
import { browserHintCopy as copy, browserHintDismissedKey } from "@/config/browser-hint";
import { detectInAppBrowser, type InAppBrowser } from "@/lib/in-app-browser";

export function BrowserHint() {
  const [browser, setBrowser] = useState<InAppBrowser>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const dismiss = useCallback(() => {
    if (noticeRef.current?.contains(document.activeElement)) {
      const target = returnFocusRef.current?.isConnected
        ? returnFocusRef.current
        : document.querySelector<HTMLElement>("main input, main button, main a[href]");
      target?.focus();
    }
    setBrowser(null);
    try {
      sessionStorage.setItem(browserHintDismissedKey, "1");
    } catch {}
  }, []);

  useEffect(() => {
    // 服务端与客户端首帧均不显示；存储受限时仍提供提醒和本次挂载内的关闭。
    try {
      if (sessionStorage.getItem(browserHintDismissedKey) === "1") return;
    } catch {}
    setBrowser(detectInAppBrowser(navigator.userAgent));
  }, []);

  useEffect(() => {
    if (!browser) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [browser, dismiss]);

  if (!browser || typeof document === "undefined") return null;

  return createPortal(
    <div className="admin-toast">
      <div
        ref={noticeRef}
        className="card admin-toast__body"
        role="status"
        aria-live="polite"
        onFocusCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            returnFocusRef.current =
              event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null;
          }
        }}
      >
        <Icon name="bell" />
        <p className="admin-toast__text">
          <strong className="mb-1 block">{copy.title}</strong>
          {copy.description.replace("{browser}", copy.browsers[browser])}
        </p>
        <button
          type="button"
          className="admin-toast__close min-h-[46px] min-w-[46px]"
          aria-label={copy.close}
          onClick={dismiss}
        >
          <Icon name="close" />
        </button>
      </div>
    </div>,
    document.body,
  );
}
