"use client";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { AdminToast, type AdminToastMessage } from "@/components/admin/AdminToast";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import {
  defaultRepairResult,
  formatBytes,
  repairEditorCopy,
  repairFieldLimits,
  repairResultLabels,
} from "@/config/repairs";
import { shanghaiToday } from "@/lib/shanghai-date";
import { createIdempotencyKey } from "@/lib/idempotency-key";
import type { RepairCategoryView, RepairDetailView, RepairMemberOption } from "@/types/contracts";

/** 点击整块日期输入框都弹出原生日历（默认只有右侧小图标会弹）。 */
function openDatePicker(event: ReactMouseEvent<HTMLInputElement>) {
  try {
    event.currentTarget.showPicker();
  } catch {
    // 浏览器拒绝时（非用户手势、选择器已打开）忽略：原生点击行为不受影响。
  }
}

export function RepairEditor({
  recordId,
  allowSaveDraft = true,
  returnActivityId,
}: {
  recordId: string;
  /** 新建流程不再暴露「草稿」（issue #72）：只留提交审核；编辑存量草稿与退回记录仍可保存。 */
  allowSaveDraft?: boolean;
  /** 从活动看板进入时，提交成功后返回该看板继续接待。 */
  returnActivityId?: string;
}) {
  const router = useRouter();
  const [record, setRecord] = useState<RepairDetailView>();
  const [categories, setCategories] = useState<RepairCategoryView[]>([]);
  /** 参与维修人员（issue #114）的候选名单：全部活跃成员，从中挑选添加。 */
  const [memberOptions, setMemberOptions] = useState<RepairMemberOption[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error" | "forbidden">("loading");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [toast, setToast] = useState<AdminToastMessage | null>(null);
  useEffect(() => {
    if (!submitted || !returnActivityId) return;
    const timer = setTimeout(() => {
      router.replace(`/member/repair-activities/${encodeURIComponent(returnActivityId)}`);
    }, 1000);
    return () => clearTimeout(timer);
  }, [submitted, returnActivityId, router]);
  const load = useCallback(async () => {
    setState("loading");
    try {
      const [a, b, c] = await Promise.all([
        fetch(`/api/v1/repairs/${recordId}`, { cache: "no-store" }),
        fetch("/api/v1/repair-categories", { cache: "no-store" }),
        fetch("/api/v1/repair-members", { cache: "no-store" }),
      ]);
      const detail = await a.json();
      const cats = await b.json();
      const members = await c.json();
      if (members.success) setMemberOptions(members.data);
      if (!detail.success) {
        setState(
          detail.error.code === "REPAIR_FORBIDDEN" || detail.error.code === "REPAIR_NOT_FOUND"
            ? "forbidden"
            : "error",
        );
        return;
      }
      if (!detail.data.canEdit) {
        setState("forbidden");
        return;
      }
      // 「不填默认今天」：空值（含更早留下的草稿）打开时即按今天显示，
      // 保存或提交那一刻才真正写进库。
      setRecord(
        detail.data.repairDate === null
          ? { ...detail.data, repairDate: shanghaiToday() }
          : detail.data,
      );
      setCategories(cats.success ? cats.data : []);
      setState("ready");
    } catch {
      setState("error");
    }
  }, [recordId]);
  useEffect(() => {
    void load();
  }, [load]);
  function field<K extends keyof RepairDetailView>(key: K, value: RepairDetailView[K]) {
    setRecord((current) => (current ? { ...current, [key]: value } : current));
  }
  /** 保存当前表单，返回服务端视图 —— `PATCH` 返回的是列表视图（无 `reviews` / `timeline`），故用合并。 */
  async function persist(): Promise<RepairDetailView> {
    if (!record) throw new Error("记录尚未加载");
    const response = await fetch(`/api/v1/repairs/${recordId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: record.version,
        repairDate: record.repairDate,
        durationMinutes: record.durationMinutes ?? null,
        categoryId: record.category?.id ?? null,
        ownerName: record.ownerName,
        ownerPhone: record.ownerPhone,
        // 不再发送 `content`：字段已从表单退场，`undefined` 即「不动」——
        // 老记录的正文不会被这里清空（issue #79 第 6 项）。
        remark: record.remark,
        result: record.result ?? defaultRepairResult,
        // 参与维修人员（issue #114）：只发送额外成员（不含创建人本人），服务端整体替换。
        participantIds: record.participants
          .filter((participant) => participant.id !== record.member.id)
          .map((participant) => participant.id),
      }),
    });
    const json = await response.json();
    if (!json.success) throw new Error(json.error.message);
    setRecord((current) => (current ? { ...current, ...json.data } : json.data));
    return json.data as RepairDetailView;
  }
  async function save() {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      await persist();
      setMessage("草稿已保存。");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }
  async function submit() {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      // 先把当前表单存一次再提交：否则「填了但没保存」会被服务端的完整性校验拦下。
      const idempotencyKey = createIdempotencyKey();
      const saved = await persist();
      const response = await fetch(`/api/v1/repairs/${recordId}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ version: saved.version }),
      });
      const json = await response.json();
      if (!json.success) {
        const fields = json.error.fieldErrors
          ? Object.values(json.error.fieldErrors).flat().join("；")
          : "";
        throw new Error(fields || json.error.message);
      }
      if (returnActivityId) {
        setToast({ text: repairEditorCopy.activitySubmitSuccess, tone: "success" });
        setSubmitted(true);
      } else {
        router.replace(`/member/repairs/${recordId}`);
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "提交失败");
      setBusy(false);
    }
  }
  /** 添加参与成员（issue #114）：创建人固定第一行、不可移除；候选里排除已加入的人。 */
  function addParticipant(memberProfileId: string) {
    if (!record || !memberProfileId) return;
    setRecord((current) => {
      if (!current) return current;
      const member = memberOptions.find((option) => option.id === memberProfileId);
      if (!member || current.participants.some((item) => item.id === memberProfileId))
        return current;
      if (current.participants.length >= repairFieldLimits.participantMaxCount) return current;
      return {
        ...current,
        participants: [...current.participants, { id: member.id, name: member.name }],
      };
    });
  }
  function removeParticipant(memberProfileId: string) {
    setRecord((current) =>
      current
        ? {
            ...current,
            participants: current.participants.filter((item) => item.id !== memberProfileId),
          }
        : current,
    );
  }
  /** 照片是即时保存的，只合并照片 —— 整块重载会丢掉表单里还没保存的改动。 */
  async function refreshPhotos() {
    const response = await fetch(`/api/v1/repairs/${recordId}`, { cache: "no-store" });
    const json = await response.json();
    if (!json.success) return;
    setRecord((current) => (current ? { ...current, photos: json.data.photos } : current));
  }
  async function upload(files: File[]) {
    if (!files.length || !record) return;
    const selected = files;
    const { maxBytes, maxFiles } = record.photoLimits;
    // 先按服务端下发的上限拦一遍：超限的文件根本传不上去，不必等 multipart 走完再说。
    const oversized = selected.find((file) => file.size > maxBytes);
    if (oversized) {
      setMessage(
        repairEditorCopy.photoTooLarge
          .replace("{name}", oversized.name)
          .replace("{size}", formatBytes(oversized.size))
          .replace("{limit}", formatBytes(maxBytes)),
      );
      return;
    }
    if (record.photos.length + selected.length > maxFiles) {
      setMessage(
        repairEditorCopy.photoTooMany
          .replace("{count}", String(record.photos.length))
          .replace("{remain}", String(Math.max(maxFiles - record.photos.length, 0))),
      );
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const form = new FormData();
      selected.forEach((file) => form.append("photos", file));
      const response = await fetch(`/api/v1/repairs/${recordId}/photos`, {
        method: "POST",
        body: form,
      });
      const json = await response.json();
      if (!json.success) throw new Error(json.error.message);
      await refreshPhotos();
      setMessage("照片已上传。");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "上传失败");
    } finally {
      setBusy(false);
    }
  }
  async function remove(photoId: string) {
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/repairs/${recordId}/photos/${photoId}`, {
        method: "DELETE",
      });
      const json = await response.json();
      if (!json.success) throw new Error(json.error.message);
      await refreshPhotos();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "移除失败");
    } finally {
      setBusy(false);
    }
  }
  async function reorder(photoId: string, sortOrder: number) {
    await fetch(`/api/v1/repairs/${recordId}/photos/${photoId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sortOrder }),
    });
    await refreshPhotos();
  }
  if (state === "loading") return <p role="status">正在加载表单…</p>;
  if (state === "error")
    return (
      <Card variant="notice">
        <p>记录加载失败。</p>
        <Button onClick={() => void load()}>重试</Button>
      </Card>
    );
  if (state === "forbidden")
    return (
      <Card variant="notice">
        <p>这条记录不存在，或当前状态不允许编辑。</p>
        <Button href="/member/repairs">返回列表</Button>
      </Card>
    );
  if (!record) return null;
  const rejection = [...record.reviews].reverse().find((item) => item.decision === "REJECTED");
  const photoHint = repairEditorCopy.photoHint
    .replace("{size}", formatBytes(record.photoLimits.maxBytes))
    .replace("{count}", String(record.photoLimits.maxFiles));
  // 参与维修人员（issue #114）：候选 = 活跃成员里还没加入的人；到上限或没有候选时禁用选择器。
  const addableMembers = memberOptions.filter(
    (option) => !record.participants.some((participant) => participant.id === option.id),
  );
  const participantsFull = record.participants.length >= repairFieldLimits.participantMaxCount;
  const participantsLimitText = repairEditorCopy.participantsLimit.replace(
    "{max}",
    String(repairFieldLimits.participantMaxCount),
  );
  return (
    <div className="repair-editor">
      <AdminToast toast={toast} onDismiss={() => setToast(null)} />
      {rejection ? (
        <Card variant="notice">
          <strong>最新退回原因</strong>
          <p>{rejection.note}</p>
        </Card>
      ) : null}
      <Card className="repair-panel">
        <form
          className="gap-s-5 grid"
          onSubmit={(e) => {
            e.preventDefault();
            // 新建流程没有「保存草稿」，回车不触发隐式保存，避免误以为已提交。
            if (allowSaveDraft) void save();
          }}
        >
          <div className="gap-s-4 grid items-start md:grid-cols-2">
            <label className="field">
              <span className="field__label">
                维修日期
                <span className="field__req">{repairEditorCopy.requiredMark}</span>
              </span>
              <input
                className="field__input"
                type="date"
                value={record.repairDate ?? ""}
                min={repairFieldLimits.repairDateMin}
                max={shanghaiToday()}
                onClick={openDatePicker}
                onChange={(e) => field("repairDate", e.target.value || null)}
              />
              <span className="field__hint">{repairEditorCopy.dateHint}</span>
            </label>
            <label className="field">
              <span className="field__label">
                {repairEditorCopy.ownerNameLabel}
                <span className="field__req">{repairEditorCopy.requiredMark}</span>
              </span>
              <input
                className="field__input"
                type="text"
                maxLength={repairFieldLimits.ownerNameMaxLength}
                value={record.ownerName ?? ""}
                onChange={(e) => field("ownerName", e.target.value || null)}
                aria-describedby="repair-owner-name-hint"
              />
              <span className="field__hint" id="repair-owner-name-hint">
                {repairEditorCopy.ownerNameHint}
              </span>
            </label>
            <label className="field">
              <span className="field__label">
                故障分类
                <span className="field__req">{repairEditorCopy.requiredMark}</span>
              </span>
              <select
                className="field__input"
                value={record.category?.id ?? ""}
                onChange={(e) =>
                  field("category", categories.find((c) => c.id === e.target.value) ?? null)
                }
              >
                <option value="">请选择</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field__label">
                维修时长（分钟）
                <span className="field__req">{repairEditorCopy.requiredMark}</span>
              </span>
              <input
                className="field__input"
                type="number"
                inputMode="numeric"
                step={1}
                min={repairFieldLimits.durationMinutesMin}
                max={repairFieldLimits.durationMinutesMax}
                value={record.durationMinutes ?? ""}
                onChange={(e) =>
                  field(
                    "durationMinutes",
                    e.target.value === "" ? null : Number.parseInt(e.target.value, 10),
                  )
                }
                aria-describedby="repair-duration-hint"
              />
              <span className="field__hint" id="repair-duration-hint">
                {repairEditorCopy.durationHint}
              </span>
            </label>
            <label className="field">
              <span className="field__label">
                {repairEditorCopy.ownerPhoneLabel}
                <span className="field__req">{repairEditorCopy.requiredMark}</span>
              </span>
              <input
                className="field__input"
                type="tel"
                inputMode="numeric"
                maxLength={11}
                value={record.ownerPhone ?? ""}
                onChange={(e) => field("ownerPhone", e.target.value || null)}
                aria-describedby="repair-owner-phone-hint"
              />
              <span className="field__hint" id="repair-owner-phone-hint">
                {repairEditorCopy.ownerPhoneHint}
              </span>
            </label>
          </div>
          {/* 已选区域固定高度并内部滚动，添加 / 移除参与者不会移动下方表单。 */}
          <div className="field">
            <span className="field__label">{repairEditorCopy.participantsLabel}</span>
            <div className="gap-s-2 flex h-32 min-w-0 flex-wrap content-start items-center overflow-y-auto overscroll-contain">
              {record.participants.map((participant) => {
                const isCreator = participant.id === record.member.id;
                return (
                  <span className="gap-s-2 flex items-center" key={participant.id}>
                    <span className="member-tag">
                      {participant.name}
                      {isCreator ? `（${repairEditorCopy.participantsCreatorTag}）` : ""}
                    </span>
                    {isCreator ? null : (
                      <Button
                        type="button"
                        disabled={busy}
                        onClick={() => removeParticipant(participant.id)}
                      >
                        {repairEditorCopy.participantsRemove}
                      </Button>
                    )}
                  </span>
                );
              })}
            </div>
            <select
              className="field__input"
              value=""
              disabled={busy || participantsFull || addableMembers.length === 0}
              onChange={(event) => addParticipant(event.target.value)}
              aria-label={repairEditorCopy.participantsAddPlaceholder}
            >
              <option value="" disabled>
                {participantsFull
                  ? participantsLimitText
                  : addableMembers.length === 0
                    ? repairEditorCopy.participantsNoOptions
                    : repairEditorCopy.participantsAddPlaceholder}
              </option>
              {addableMembers.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </select>
            <span className="field__hint">
              {repairEditorCopy.participantsHint}
              {participantsLimitText}。
            </span>
          </div>
          <p className="field__hint">
            {allowSaveDraft ? repairEditorCopy.requiredNote : repairEditorCopy.requiredNoteCreate}
          </p>
          <p className="field__hint">
            维修结果默认为「{repairResultLabels[defaultRepairResult]}」，保存与提交都会按此记录。
          </p>
          <p className="field__hint">当前版本：{record.version}</p>
          <div className="signup__actions">
            {allowSaveDraft ? (
              <Button type="submit" disabled={busy}>
                保存草稿
              </Button>
            ) : null}
            <Button type="button" variant="solid" disabled={busy} onClick={() => void submit()}>
              提交审核
            </Button>
          </div>
          {message ? (
            <p className="signup__status" role="status">
              {message}
            </p>
          ) : null}
        </form>
      </Card>
      <Card className="repair-panel">
        <div>
          <h2 className="text-display-3 font-bold">{repairEditorCopy.attachmentsTitle}</h2>
        </div>
        <label className="field">
          <span className="field__label">{repairEditorCopy.remarkLabel}</span>
          <textarea
            className="field__input min-h-40"
            maxLength={repairFieldLimits.remarkMaxLength}
            value={record.remark ?? ""}
            onChange={(e) => field("remark", e.target.value || null)}
            aria-describedby="repair-remark-hint"
          />
          <span className="field__hint" id="repair-remark-hint">
            {repairEditorCopy.remarkHint}
          </span>
        </label>
        <label className="field">
          <span className="field__label">选择照片</span>
          <input
            className="field__input"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            disabled={busy}
            onChange={(e) => {
              // 先拷成数组再清空 input：Blink 的 FileList 是活视图，清空 value 会把它一起清空，
              // 存引用再清空等于传了个空列表；拷成数组后「同一张图片再选一次」也能触发 change。
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              void upload(files);
            }}
          />
          <span className="field__hint">{photoHint}</span>
        </label>
        <div className="gap-s-4 grid md:grid-cols-2">
          {record.photos.map((photo, index) => (
            <figure className="gap-s-2 grid" key={photo.id}>
              <Image
                className="rounded-mid border-line h-56 w-full border object-cover"
                src={photo.contentUrl}
                alt={`维修照片 ${index + 1}`}
                width={720}
                height={480}
                unoptimized
              />
              <figcaption className="gap-s-2 flex flex-wrap">
                <Button
                  disabled={index === 0 || busy}
                  onClick={() => void reorder(photo.id, index - 1)}
                >
                  前移
                </Button>
                <Button
                  disabled={index === record.photos.length - 1 || busy}
                  onClick={() => void reorder(photo.id, index + 1)}
                >
                  后移
                </Button>
                <Button disabled={busy} onClick={() => void remove(photo.id)}>
                  移除
                </Button>
              </figcaption>
            </figure>
          ))}
        </div>
      </Card>
    </div>
  );
}
