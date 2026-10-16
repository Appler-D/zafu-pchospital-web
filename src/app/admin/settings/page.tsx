import type { Metadata } from "next";

import { PublicContentSettingsPanel } from "@/components/admin/PublicContentSettingsPanel";
import { Section } from "@/components/ui/Section";
import { adminCopy } from "@/config/admin";
import { requireAdminPage } from "@/lib/auth/admin-page";

export const metadata: Metadata = { title: adminCopy.settings.title };

export default async function AdminSettingsPage() {
  await requireAdminPage();
  return (
    <Section variant="page-head" className="admin-workspace" labelledBy="admin-settings-title">
      <div className="admin-workspace__content">
        <PublicContentSettingsPanel />
      </div>
    </Section>
  );
}
