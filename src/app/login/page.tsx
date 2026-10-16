import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { LoginPanel, type AuthPanelMode } from "@/components/auth/LoginPanel";
import { Section } from "@/components/ui/Section";
import { authService } from "@/features/auth/auth-service";
import { AppError } from "@/lib/api/errors";
import { accountReturnCandidate, resolveAccountAccess } from "@/lib/auth/account-access";
import { SESSION_COOKIE_NAME } from "@/lib/auth/request";

export const metadata: Metadata = { title: "成员登录" };

type LoginPageProps = {
  searchParams: Promise<{
    mode?: string | string[];
    reason?: string | string[];
    returnTo?: string | string[];
  }>;
};

function resolveMode(raw: string | string[] | undefined): AuthPanelMode {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === "register" ? "register" : "login";
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  const params = await searchParams;
  const requestedReturnTo = Array.isArray(params.returnTo) ? params.returnTo[0] : params.returnTo;
  // 未认证时没有角色可查，先按**形状**过滤（只留规范业务 pathname），拼回链接与表单的
  // 就只有安全值；真正的准入判定在认证之后由 `safeAccountReturnPath` 按当次角色做。
  const candidate = accountReturnCandidate(requestedReturnTo);
  let destination: string | undefined;
  if (token) {
    try {
      const principal = await authService.authenticate(token);
      // 已登录访问 /login 走与登录接口、页面守卫同一套服务端落点编排（任务 6）：
      // 未走完的步骤优先，其次才是原目标 / 角色默认页。
      destination = (await resolveAccountAccess({ principal, returnTo: candidate })).destination;
    } catch (error) {
      if (
        !(error instanceof AppError) ||
        ![
          "AUTH_SESSION_INVALID",
          "AUTH_SESSION_EXPIRED",
          "ACCOUNT_DISABLED",
          "MEMBER_PROFILE_INACTIVE",
        ].includes(error.code)
      )
        throw error;
      if (!Array.isArray(params.reason) && params.reason !== "expired")
        redirect(
          candidate
            ? `/login?reason=expired&returnTo=${encodeURIComponent(candidate)}`
            : "/login?reason=expired",
        );
    }
  }
  if (destination) redirect(destination);
  const mode = resolveMode(params.mode);

  return (
    <Section variant="page-head" className="auth-login" labelledBy="login-title">
      <LoginPanel mode={mode} returnTo={candidate} />
    </Section>
  );
}
