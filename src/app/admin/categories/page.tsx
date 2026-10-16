import type { Metadata } from "next";

import { CategoryAdminPanel } from "@/components/admin/CategoryAdminPanel";
import { Section } from "@/components/ui/Section";
import { adminCopy } from "@/config/admin";
import { requireAdminPage } from "@/lib/auth/admin-page";

export const metadata: Metadata = { title: adminCopy.categories.title };

export default async function AdminCategoriesPage() {
  await requireAdminPage();
  return (
    <Section variant="page-head" className="admin-workspace" labelledBy="admin-categories-title">
      <div className="admin-workspace__content">
        <CategoryAdminPanel />
      </div>
    </Section>
  );
}
