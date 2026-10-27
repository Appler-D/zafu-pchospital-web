import type { Metadata } from "next";

import { NotificationInbox } from "@/components/community/NotificationInbox";
import { MemberPageHead } from "@/components/member/MemberPageHead";
import { Section } from "@/components/ui/Section";
import { communityCopy } from "@/config/community";
import { requireActiveMemberPage } from "@/lib/auth/member-page";

export const metadata: Metadata = { title: communityCopy.notifications.title };

/** `/member/notifications` —— 消息通知。 */
export default async function MemberNotificationsPage() {
  await requireActiveMemberPage();
  const copy = communityCopy.notifications;
  return (
    <Section
      variant="page-head"
      className="member-workspace member-compact-workspace"
      labelledBy="member-notifications-title"
    >
      <MemberPageHead id="member-notifications-title" label={copy.label} title={copy.title} />
      <NotificationInbox />
    </Section>
  );
}
