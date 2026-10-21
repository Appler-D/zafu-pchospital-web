import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/auth/admin-page";

export default async function AdminCommentsPage() {
  await requireAdminPage();
  notFound();
}
