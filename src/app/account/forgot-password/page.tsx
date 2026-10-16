import { ForgotPasswordForm } from "@/components/account/ForgotPasswordForm";
import { AuthPanel } from "@/components/auth/AuthPanel";
import { Section } from "@/components/ui/Section";
import { passwordRecoveryCopy as copy } from "@/config/password-recovery";
export const metadata = { title: copy.title, robots: { index: false, follow: false } };
export default function ForgotPasswordPage() {
  return (
    <Section variant="page-head" className="auth-login" labelledBy="forgot-password-title">
      <AuthPanel
        titleId="forgot-password-title"
        eyebrow={copy.label}
        title={copy.title}
        lead={copy.lead}
      >
        <ForgotPasswordForm />
      </AuthPanel>
    </Section>
  );
}
