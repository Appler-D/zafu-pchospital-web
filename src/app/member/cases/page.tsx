import type { Metadata } from "next";

import { CaseLibrary } from "@/components/cases/CaseLibrary";
import { Section } from "@/components/ui/Section";
import { casesCopy } from "@/config/cases";
import { requireActiveMemberPage } from "@/lib/auth/member-page";

export const metadata: Metadata = { title: casesCopy.title };

/**
 * `/member/cases` —— 成员案例库。
 *
 * 页头用成员端紧凑范式：与 `/member/rankings`、`/member/profile`
 * 同为 `Section variant="page-head" className="member-workspace"`；页面主标题是
 * `CaseLibrary` 内的 h1（其 id 由本 section 的 aria-labelledby 引用）。
 *
 * 不再使用官网式 `PageHead`：它的 `.reveal` 元素在成员壳内特异性败给
 * `html.js .reveal`、SiteEffects 又跳过成员壳不播放，标题整块不可见，只剩留白。
 */
export default async function MemberCasesPage() {
  await requireActiveMemberPage();
  return (
    <Section variant="page-head" className="member-workspace" labelledBy="member-cases-title">
      <CaseLibrary />
    </Section>
  );
}
