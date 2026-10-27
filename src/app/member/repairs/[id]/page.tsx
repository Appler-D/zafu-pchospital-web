import type { Metadata } from "next";
import { MemberPageHead } from "@/components/member/MemberPageHead";
import { RepairDetail } from "@/components/repairs/RepairDetail";
import { Section } from "@/components/ui/Section";
import {
  repairCopy,
  repairResultLabels,
  repairStatusLabels,
  repairTimelineLabels,
} from "@/config/repairs";
import { requireActiveMemberPage } from "@/lib/auth/member-page";
export const metadata: Metadata = { title: "维修记录详情" };
export default async function RepairDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireActiveMemberPage();
  const { id } = await params;
  return (
    <div className="repair-page">
      <Section variant="page-head" labelledBy="repair-detail-title">
        <MemberPageHead
          id="repair-detail-title"
          label={repairCopy.detail.label}
          title={repairCopy.detail.title}
        />
      </Section>
      <Section labelledBy="repair-detail-content">
        <h2 className="sr-only" id="repair-detail-content">
          维修记录内容
        </h2>
        <RepairDetail
          recordId={id}
          statusLabels={repairStatusLabels}
          resultLabels={repairResultLabels}
          timelineLabels={repairTimelineLabels}
        />
      </Section>
    </div>
  );
}
