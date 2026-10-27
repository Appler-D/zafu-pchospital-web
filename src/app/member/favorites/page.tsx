import type { Metadata } from "next";

import { FavoriteList } from "@/components/community/FavoriteList";
import { MemberPageHead } from "@/components/member/MemberPageHead";
import { Section } from "@/components/ui/Section";
import { communityCopy } from "@/config/community";
import { requireActiveMemberPage } from "@/lib/auth/member-page";

export const metadata: Metadata = { title: communityCopy.favorites.title };

export default async function MemberFavoritesPage() {
  await requireActiveMemberPage();
  const copy = communityCopy.favorites;
  return (
    <Section
      variant="page-head"
      className="member-workspace member-compact-workspace"
      labelledBy="member-favorites-title"
    >
      <MemberPageHead id="member-favorites-title" label={copy.label} title={copy.title} />
      <FavoriteList />
    </Section>
  );
}
