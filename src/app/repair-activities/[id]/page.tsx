import type { Metadata } from "next";

import { RepairActivityDetail } from "@/components/repair-activities/RepairActivityDetail";
import { Section } from "@/components/ui/Section";
import { repairActivitiesPage } from "@/config/repair-activities";

export const metadata: Metadata = {
  title: repairActivitiesPage.title,
  description: repairActivitiesPage.lead,
};

export default async function RepairActivityDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <div className="repair-page">
      <Section labelledBy="repair-activity-detail-title">
        <RepairActivityDetail activityId={id} />
      </Section>
    </div>
  );
}
