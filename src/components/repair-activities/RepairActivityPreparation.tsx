import { Icon } from "@/components/ui/Icon";
import { repairActivitiesPage } from "@/config/repair-activities";

import styles from "./RepairActivityDetail.module.css";

/** 常驻区与成功提醒共用的到场行动摘要；完整声明仍由 Precautions 展示。 */
export function RepairActivityPreparation() {
  return (
    <ul className={styles.preparation}>
      {repairActivitiesPage.detail.preparation.map((item) => (
        <li key={item.title}>
          <Icon name={item.icon} />
          <div>
            <h3>{item.title}</h3>
            <p>{item.description}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}
