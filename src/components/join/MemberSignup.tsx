"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/Button";
import { Reveal } from "@/components/ui/Reveal";
import { Section } from "@/components/ui/Section";
import { SectionHead } from "@/components/ui/SectionHead";
import { SectionTitle } from "@/components/ui/SectionTitle";
import { joinSections, joinSignup, joinSignupFields, joinSignupQr } from "@/config/join";
import { AppError, type FieldErrors } from "@/lib/api/errors";
import { normalizeMemberSignup, submitMemberSignup } from "@/lib/member-signup";
import type { MemberSignupInput, MemberSignupReceipt } from "@/lib/member-signup";
import { pad2, revealIndex } from "@/lib/utils";

/**
 * MemberSignup —— /join「新社员信息登记」区块
 *
 * 页面里唯一需要交互的区块，因此是客户端组件；视觉全部来自设计系统，
 * 没有为表单新造颜色、字号或圆角（样式见 globals.css 的 .signup / .field）。
 *
 * 几个刻意的取舍：
 * 1. 原生约束辅助必填 / 长度 / 格式；邮箱复用 normalizeEmail，服务端仍做权威校验。
 *    统一 fieldErrors 在字段旁呈现，格式规则不在组件中另写一份。
 * 2. 提交逻辑只有 submitMemberSignup 一个入口（src/lib/member-signup.ts）。
 *    它调用同源 API，并统一处理服务端回执与错误信封。
 * 3. 按钮在 hydration 完成前是禁用态（见下面 ready 的注释）。
 *    页面是 SSR 出来的，脚本就绪之前表单已经长在页面上：这段时间点「提交登记」，
 *    浏览器会做一次**原生表单提交**（POST 到本页），整页重载、字段清空，
 *    而报名根本没进系统 —— 用户看到的正是「提交很慢、没有任何反馈」，还会重复提交。
 *    2026-09-28 实测（生产站，Slow 3G + CPU 4 倍降速）：hydration 要 5.6 秒才完成，
 *    低端手机上的这个窗口相当大。宁可点不动，也不能看起来成功却丢件；
 *    这段时间按钮旁的状态行写的是「正在加载表单」，就绪后换成隐私告知。
 * 4. 提交完成后才渲染招新群二维码 ——「填写完成后进行显示」。
 *    这一块不能包 Reveal：SiteEffects 只在挂载时收集一次 .reveal，
 *    后插入的 .reveal 永远不会拿到 .is-in，会一直停在 opacity: 0。
 *    也不做「自动滚到二维码」：二维码要等图片加载完才撑开高度，
 *    此时按错误高度滚动反而会把版面推歪。它就在右侧（小屏在下方），
 *    面板里也写清了「最后一步：扫码加入招新群」。
 * 5. form 显式声明 method="post"：万一仍有原生提交发生（脚本不可用、或被禁用的
 *    按钮绕过去了），用 GET 会把手机号写进地址栏与浏览器历史，post 至少不泄漏到 URL。
 */

type SignupStatus = "idle" | "submitting" | "done";

export function MemberSignup() {
  const [status, setStatus] = useState<SignupStatus>("idle");
  const [problem, setProblem] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [receipt, setReceipt] = useState<MemberSignupReceipt | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  /**
   * 只有脚本接上（hydration 完成）之后才允许提交：这之前按钮按下会走浏览器原生提交，
   * 结果是整页重载 + 报名丢失（原因见文件头注释 3）。
   */
  const [ready, setReady] = useState(false);
  const submitting = status === "submitting";
  const done = status === "done";
  // 就绪说明必须写进 SSR 输出：等脚本接上才换提示，慢网络下那段等待仍然是「点了没反应」。
  // 失败原因也走这一行（就地替换）：不插入新元素，下方内容不会被顶动。
  const statusNote = problem
    ? problem
    : submitting
      ? joinSignup.submittingNote
      : ready
        ? joinSignup.privacy
        : joinSignup.loadingNote;

  useEffect(() => setReady(true), []);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    // submit 事件只有在原生约束校验通过后才会触发，这里直接进入提交。
    const form = event.currentTarget;
    setProblem("");
    setFieldErrors({});
    setStatus("submitting");

    let input: MemberSignupInput;
    try {
      input = normalizeMemberSignup(new FormData(form));
    } catch (error) {
      if (error instanceof AppError) {
        setFieldErrors(error.fieldErrors ?? {});
        setProblem(error.message);
        setStatus("idle");
        return;
      }
      throw error;
    }
    const result = await submitMemberSignup(input);

    if (result.ok) {
      setReceipt(result);
      setStatus("done");
      return;
    }

    setProblem(result.message);
    setFieldErrors(result.fieldErrors ?? {});
    setStatus("idle");
  };

  const handleReset = () => {
    formRef.current?.reset();
    setProblem("");
    setFieldErrors({});
    setReceipt(null);
    setStatus("idle");
  };

  return (
    <Section id="signup" labelledBy="join-signup-title">
      <SectionHead index={joinSections.signup.index} label={joinSections.signup.label} />
      <div className="sec-titlebar">
        <SectionTitle id="join-signup-title">{joinSections.signup.title}</SectionTitle>
        <Reveal as="p" className="sec-note" index={2}>
          {joinSignup.note}
        </Reveal>
      </div>

      <div className="signup">
        <Reveal index={3}>
          {done ? (
            <div className="signup__done" role="status">
              <p className="eyebrow">{joinSignup.done.mark}</p>
              <h3 className="signup__done-title">{joinSignup.done.title}</h3>
              <p className="signup__done-note">{joinSignup.done.note}</p>
              <p className="signup__done-note">
                {joinSignup.done.ticketLabel}：{receipt?.ticket}
              </p>
              {receipt?.duplicate ? (
                <p className="signup__done-note">{joinSignup.done.duplicate}</p>
              ) : null}
              <Button variant="ghost" onClick={handleReset}>
                {joinSignup.done.reset}
              </Button>
            </div>
          ) : (
            <form
              className="signup__form"
              ref={formRef}
              method="post"
              onSubmit={handleSubmit}
              aria-busy={submitting}
            >
              {joinSignupFields.map((field, index) => (
                <div className="field" key={field.name}>
                  <label className="field__label" htmlFor={`signup-${field.name}`}>
                    <span className="field__num">{pad2(index + 1)}</span>
                    <span>{field.label}</span>
                    <span className="field__req">{joinSignup.requiredMark}</span>
                  </label>

                  <input
                    className="field__input"
                    id={`signup-${field.name}`}
                    name={field.name}
                    type={field.type}
                    inputMode={field.inputMode}
                    autoComplete={field.autoComplete}
                    pattern={field.pattern}
                    minLength={field.minLength}
                    maxLength={field.maxLength}
                    placeholder={field.placeholder}
                    aria-invalid={!!fieldErrors[field.name]?.length}
                    aria-describedby={`signup-${field.name}-hint${fieldErrors[field.name]?.length ? ` signup-${field.name}-error` : ""}`}
                    disabled={submitting}
                    required
                  />

                  <p className="field__hint" id={`signup-${field.name}-hint`}>
                    {field.hint}
                  </p>
                  {fieldErrors[field.name]?.length ? (
                    <p
                      className="field__hint text-accent-deep"
                      id={`signup-${field.name}-error`}
                      role="alert"
                    >
                      {fieldErrors[field.name].join("；")}
                    </p>
                  ) : null}
                </div>
              ))}

              <div className="signup__actions">
                <Button type="submit" variant="solid" disabled={!ready || submitting}>
                  {submitting ? joinSignup.submittingLabel : joinSignup.submitLabel}
                </Button>
                {/* 状态行常驻：加载 / 提交中 / 隐私说明 / 失败原因都在同一行里原地替换
                    （只换文字与颜色，不插入元素、不改变 flex 行结构），
                    页面高度不因反馈变化，下方内容不会被顶动。 */}
                <p
                  className={problem ? "signup__status text-accent-deep" : "signup__status"}
                  role={problem ? "alert" : "status"}
                  aria-live={problem ? "assertive" : "polite"}
                >
                  {statusNote}
                </p>
              </div>
            </form>
          )}
        </Reveal>

        <aside className="signup__aside reveal" style={revealIndex(4)}>
          {done ? (
            <figure className="qr">
              {/* 两张同码不同底色的图都在 DOM 里，由 CSS 按主题显示其中一张。
                  隐藏的那张是 display:none，不会进入无障碍树，也不会被重复朗读。 */}
              {/* eslint-disable-next-line @next/next/no-img-element -- 静态资源，尺寸固定，无需 next/image */}
              <img
                className="qr__img qr-img qr-img--light"
                src={joinSignupQr.srcLight}
                alt={joinSignupQr.alt}
                loading="lazy"
                decoding="async"
              />
              {/* eslint-disable-next-line @next/next/no-img-element -- 同上，深色主题取图 */}
              <img
                className="qr__img qr-img qr-img--dark"
                src={joinSignupQr.src}
                alt={joinSignupQr.alt}
                loading="lazy"
                decoding="async"
              />
              <figcaption className="qr__cap">
                <strong>{joinSignupQr.caption}</strong>
                <span>{joinSignupQr.hint}</span>
              </figcaption>
            </figure>
          ) : (
            <>
              <h3 className="eyebrow">{joinSignup.asideTitle}</h3>
              <dl className="archive__list">
                {joinSignup.asideRows.map((row) => (
                  <div className="archive__row" key={row.key}>
                    <dt className="archive__key">{row.key}</dt>
                    <dd className="archive__val">{row.value}</dd>
                  </div>
                ))}
              </dl>
            </>
          )}
        </aside>
      </div>
    </Section>
  );
}
