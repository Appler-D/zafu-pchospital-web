import { AccountEmailForm } from "@/components/account/AccountEmailForm";
import { AuthPanel } from "@/components/auth/AuthPanel";
import { Section } from "@/components/ui/Section";
import { accountEmailCopy as copy } from "@/config/account-email";
import { requireEmailStepPage } from "@/lib/auth/member-page";
export const metadata = { title: copy.title, robots: { index: false, follow: false } };

type AccountEmailPageProps = { searchParams: Promise<{ returnTo?: string | string[] }> };

export default async function AccountEmailPage({ searchParams }: AccountEmailPageProps) {
  const params = await searchParams;
  const rawReturnTo = Array.isArray(params.returnTo) ? params.returnTo[0] : params.returnTo;
  // 步骤页：基础 Session + 强制改密照旧，邮箱门禁只豁免本步骤；不要求 MemberProfile。
  const { principal, target, continueTo } = await requireEmailStepPage(rawReturnTo);
  // 恢复工具入口由服务端按当次角色 + 权限授予；临时豁免不授予任何权限。
  const canRecover =
    principal.roles.includes("ADMIN") && principal.permissions.includes("member:manage");
  return (
    <Section variant="page-head" className="auth-login" labelledBy="email-title">
      <AuthPanel titleId="email-title" eyebrow={copy.label} title={copy.title} lead={copy.lead}>
        <AccountEmailForm continueTo={continueTo} returnTo={target} canRecover={canRecover} />
      </AuthPanel>
    </Section>
  );
}
