import type { Metadata } from "next";
import { ChangePasswordForm } from "@/components/auth/ChangePasswordForm";
import { PageHead } from "@/components/layout/PageHead";
import { Section } from "@/components/ui/Section";
export const metadata: Metadata = { title: "修改密码" };

type ChangePasswordPageProps = {
  searchParams: Promise<{ returnTo?: string | string[] }>;
};

export default async function ChangePasswordPage({ searchParams }: ChangePasswordPageProps) {
  const params = await searchParams;
  // 原目标只作为**候选**传给接口：服务端按白名单与当前角色再校验（任务 6）。
  // 本页不设守卫 —— 强制改密的会话必须能到达这里，且此时不应被邮箱门禁拦住。
  const returnTo = Array.isArray(params.returnTo) ? params.returnTo[0] : params.returnTo;
  return (
    <>
      <PageHead
        id="change-password-title"
        index="10"
        label="Account"
        title="修改密码"
        lead="首次登录必须先更换初始密码。"
      />
      <Section labelledBy="change-password-form-title">
        <h2 className="sr-only" id="change-password-form-title">
          修改密码表单
        </h2>
        <ChangePasswordForm returnTo={returnTo} />
      </Section>
    </>
  );
}
