import type { Metadata } from "next";

import { NotificationInbox } from "@/components/community/NotificationInbox";
import { Section } from "@/components/ui/Section";
import { communityCopy } from "@/config/community";
import { requireActiveMemberPage } from "@/lib/auth/member-page";

export const metadata: Metadata = { title: communityCopy.notifications.title };

/**
 * `/member/notifications` —— 消息通知。
 *
 * 官网式 `PageHead` 依赖的 reveal 在成员壳内不会触发，页头会整块不可见；
 * 这里使用成员端紧凑页头。
 */
export default async function MemberNotificationsPage() {
  await requireActiveMemberPage();
  const copy = communityCopy.notifications;
  return (
    <Section
      variant="page-head"
      className="member-workspace member-notifications-workspace"
      labelledBy="member-notifications-title"
    >
      <header className="member-page-head">
        <p className="member-section__tag">{copy.label}</p>
        <h1 className="sec-title" id="member-notifications-title">
          {copy.title}
        </h1>
      </header>
      <NotificationInbox />
    </Section>
  );
}
