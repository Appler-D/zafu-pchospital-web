import { Button } from "@/components/ui/Button";
import { shellNavigationCopy } from "@/config/navigation";

/** 成员与管理导航共用的官网入口；只跳转，不改变当前会话。 */
export function ShellHomeLink() {
  return (
    <Button href="/" icon="home" className="shell-home-link">
      {shellNavigationCopy.backHome}
    </Button>
  );
}
