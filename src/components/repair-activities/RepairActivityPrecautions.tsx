import { repairActivitiesPage } from "@/config/repair-activities";

/** 页面展开区与报名前确认共用同一份完整须知。 */
export function RepairActivityPrecautions() {
  return (
    <ol className="admin-plain-list">
      {repairActivitiesPage.detail.consent.clauses.map((clause) => (
        <li key={clause}>{clause}</li>
      ))}
    </ol>
  );
}
