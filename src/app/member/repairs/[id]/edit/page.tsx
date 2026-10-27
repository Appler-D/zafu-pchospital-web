import type { Metadata } from "next";
import { MemberPageHead } from "@/components/member/MemberPageHead";
import { RepairEditor } from "@/components/repairs/RepairEditor";
import { Section } from "@/components/ui/Section";
import { repairCopy } from "@/config/repairs";
import { requireActiveMemberPage } from "@/lib/auth/member-page";
export const metadata: Metadata = { title: "编辑维修记录" };
export default async function EditRepairPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ returnActivityId?: string | string[] }>;
}) {
  await requireActiveMemberPage();
  const { id } = await params;
  const { returnActivityId } = await searchParams;
  return (
    <div className="repair-page">
      <Section variant="page-head" labelledBy="edit-repair-title">
        <MemberPageHead
          id="edit-repair-title"
          label={repairCopy.edit.label}
          title={repairCopy.edit.title}
          lead={repairCopy.edit.lead}
        />
      </Section>
      <Section labelledBy="edit-repair-form">
        <h2 className="sr-only" id="edit-repair-form">
          维修记录表单
        </h2>
        <RepairEditor
          recordId={id}
          returnActivityId={typeof returnActivityId === "string" ? returnActivityId : undefined}
        />
      </Section>
    </div>
  );
}
