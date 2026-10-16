import type { Metadata } from "next";

import { InviteCodeAdminPanel } from "@/components/admin/InviteCodeAdminPanel";
import { Section } from "@/components/ui/Section";
import { adminCopy } from "@/config/admin";
import { requireAdminPage } from "@/lib/auth/admin-page";

export const metadata: Metadata = { title: adminCopy.inviteCodes.title };

export default async function AdminInviteCodesPage() {
  await requireAdminPage();
  return (
    <Section variant="page-head" className="admin-workspace" labelledBy="admin-invite-codes-title">
      <div className="admin-workspace__content">
        <InviteCodeAdminPanel />
      </div>
    </Section>
  );
}
