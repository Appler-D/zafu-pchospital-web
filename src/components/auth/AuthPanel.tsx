import Link from "next/link";
import type { ReactNode } from "react";

import { loginCopy } from "@/config/auth";
import { cn } from "@/lib/utils";

/** 登录、注册及账号操作共用同一个面板。 */
export function AuthPanel({
  title,
  titleId,
  eyebrow,
  lead,
  className,
  children,
}: {
  title: string;
  titleId: string;
  eyebrow: string;
  lead?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("auth-login__panel", className)}>
      <Link className="auth-login__brand" href="/" aria-label={`${loginCopy.brandName} · 返回首页`}>
        <b>{loginCopy.brandMark}</b>
        <span>{loginCopy.brandName}</span>
      </Link>
      <header className="auth-login__header">
        <p className="eyebrow">{eyebrow}</p>
        <h1 id={titleId}>{title}</h1>
        {lead ? <p>{lead}</p> : null}
      </header>
      {children}
    </div>
  );
}
