type Props = {
  id: string;
  label: string;
  title: string;
  lead?: string;
};

/**
 * 成员端页面标题。
 *
 * 官网式 `PageHead` 依赖的 reveal 在成员壳内不会触发，标题会整块不可见；
 * 成员页直接渲染可见的标题与标签。
 */
export function MemberPageHead({ id, label, title, lead }: Props) {
  return (
    <header className="member-page-head">
      <p className="member-section__tag">{label}</p>
      <h1 className="sec-title" id={id}>
        {title}
      </h1>
      {lead ? <p className="muted">{lead}</p> : null}
    </header>
  );
}
