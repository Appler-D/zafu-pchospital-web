import type { Metadata } from "next";

import { ExportPanel } from "@/components/admin/ExportPanel";
import { Section } from "@/components/ui/Section";
import { adminCopy } from "@/config/admin";
import { requireAdminPage } from "@/lib/auth/admin-page";

export const metadata: Metadata = { title: adminCopy.export.title };

export default async function AdminExportPage() {
  await requireAdminPage();
  return (
    <Section variant="page-head" className="admin-workspace" labelledBy="admin-export-title">
      <div className="admin-workspace__content">
        <ExportPanel />
      </div>
    </Section>
  );
}
