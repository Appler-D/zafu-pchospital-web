import type { Metadata } from "next";

import { JoinApplicationAdminPanel } from "@/components/admin/JoinApplicationAdminPanel";
import { Section } from "@/components/ui/Section";
import { adminCopy } from "@/config/admin";
import { requireAdminPage } from "@/lib/auth/admin-page";

export const metadata: Metadata = { title: adminCopy.recruitment.title };

export default async function AdminRecruitmentPage() {
  await requireAdminPage();
  return (
    <Section variant="page-head" className="admin-workspace" labelledBy="admin-recruitment-title">
      <div className="admin-workspace__content">
        <JoinApplicationAdminPanel />
      </div>
    </Section>
  );
}
