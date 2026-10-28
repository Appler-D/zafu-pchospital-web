import { Icon } from "@/components/ui/Icon";
import { repairWorkflowLink } from "@/config/browser-hint";

export function RepairWorkflowLink() {
  return (
    <a
      href={repairWorkflowLink.href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-ink-4 decoration-accent-line hover:text-accent-deep focus-visible:text-accent-deep inline-flex items-center gap-1 font-bold underline underline-offset-[0.22em] hover:decoration-current focus-visible:decoration-current"
    >
      {repairWorkflowLink.label}
      <Icon name="arrowUpRight" className="size-3" />
      <span className="sr-only">{repairWorkflowLink.newTab}</span>
    </a>
  );
}
