import type { Metadata } from "next";

import { CommentAdminPanel } from "@/components/admin/CommentAdminPanel";
import { Section } from "@/components/ui/Section";
import { adminCopy } from "@/config/admin";
import { requireAdminPage } from "@/lib/auth/admin-page";

export const metadata: Metadata = { title: adminCopy.comments.title };

export default async function AdminCommentsPage() {
  await requireAdminPage();
  return (
    <Section variant="page-head" className="admin-workspace" labelledBy="admin-comments-title">
      <div className="admin-workspace__content">
        <CommentAdminPanel />
      </div>
    </Section>
  );
}
