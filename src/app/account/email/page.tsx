import { Suspense } from "react";
import { AccountEmailForm } from "@/components/account/AccountEmailForm";
import { PageHead } from "@/components/layout/PageHead";
import { Section } from "@/components/ui/Section";
import { accountEmailCopy as copy } from "@/config/account-email";
import { requireMemberPage } from "@/lib/auth/member-page";
export const metadata = { title: copy.title, robots: { index: false, follow: false } };
export default async function AccountEmailPage() {
  await requireMemberPage(); // 基础 Session + 强制改密；不要求 MemberProfile。
  return (
    <>
      <PageHead
        id="email-title"
        index="11"
        label={copy.label}
        title={copy.title}
        lead={copy.lead}
      />
      <Section labelledBy="email-title">
        <Suspense fallback={<p>{copy.loading}</p>}>
          <AccountEmailForm />
        </Suspense>
      </Section>
    </>
  );
}
