import type { Metadata } from "next";

import { RepairActivityAdminPanel } from "@/components/admin/RepairActivityAdminPanel";
import { Section } from "@/components/ui/Section";
import { adminCopy } from "@/config/admin";
import { requireAdminPage } from "@/lib/auth/admin-page";

export const metadata: Metadata = { title: adminCopy.repairActivities.title };

export default async function AdminRepairActivitiesPage() {
  await requireAdminPage();
  return (
    <Section
      variant="page-head"
      className="admin-workspace"
      labelledBy="admin-repair-activities-title"
    >
      <div className="admin-workspace__content">
        <RepairActivityAdminPanel />
      </div>
    </Section>
  );
}
