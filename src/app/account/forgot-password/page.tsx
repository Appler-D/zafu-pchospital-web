import { ForgotPasswordForm } from "@/components/account/ForgotPasswordForm";
import { PageHead } from "@/components/layout/PageHead";
import { Section } from "@/components/ui/Section";
import { passwordRecoveryCopy as copy } from "@/config/password-recovery";
export const metadata = { title: copy.title, robots: { index: false, follow: false } };
export default function ForgotPasswordPage() {
  return (
    <>
      <PageHead
        id="forgot-password-title"
        index="12"
        label={copy.label}
        title={copy.title}
        lead={copy.lead}
      />
      <Section labelledBy="forgot-password-title">
        <ForgotPasswordForm />
      </Section>
    </>
  );
}
