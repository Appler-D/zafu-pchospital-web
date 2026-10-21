"use client";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { AdminToast, type AdminToastMessage } from "@/components/admin/AdminToast";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { RepairParticipantPicker } from "@/components/ui/RepairParticipantPicker";
import {
  defaultRepairResult,
  formatBytes,
  repairEditorCopy,
  repairFieldLimits,
  repairResultLabels,
} from "@/config/repairs";
import { shanghaiToday } from "@/lib/shanghai-date";
import { createIdempotencyKey } from "@/lib/idempotency-key";
import type {
  RepairCategoryView,
  RepairDetailView,
  RepairMemberOption,
  RepairParticipantView,
} from "@/types/contracts";
import {
  clearCreateDraft,
  hasCreateDraftContent,
  readCreateDraft,
  writeCreateDraft,
  type CreateDraftSnapshot,
} from "./create-draft-storage";

/** 点击整块日期输入框都弹出原生日历（默认只有右侧小图标会弹）。 */
function openDatePicker(event: ReactMouseEvent<HTMLInputElement>) {
  try {
    event.currentTarget.showPicker();
  } catch {
    // 浏览器拒绝时（非用户手势、选择器已打开）忽略：原生点击行为不受影响。
  }
}

/**
 * 新建页的本地初始记录（issue #162）：没有服务端 ID / 版本，照片为空。
 * 照片上限在首次建档后由服务端详情补齐，因此这里用 Infinity 占位（提示文案同步改为通用口径）。
 */
function localDraftRecord(input: {
  creator: { id: string; name: string };
  categories: RepairCategoryView[];
  participants: RepairParticipantView[];
  stored: CreateDraftSnapshot | null;
}): RepairDetailView {
  const now = new Date().toISOString();
  const categoryId = input.stored?.categoryId ?? null;
  return {
    id: "",
    member: input.creator,
    participants: [input.creator, ...input.participants],
    repairDate: input.stored?.repairDate ?? shanghaiToday(),
    durationMinutes: input.stored?.durationMinutes ?? null,
    category: categoryId ? (input.categories.find((item) => item.id === categoryId) ?? null) : null,
    deviceModel: null,
    ownerName: input.stored?.ownerName ?? null,
    ownerPhone: input.stored?.ownerPhone ?? null,
    content: null,
    result: defaultRepairResult,
    remark: input.stored?.remark ?? null,
    status: "DRAFT",
    isDifficult: false,
    isTypical: false,
    version: 0,
    submittedAt: null,
    reviewedAt: null,
    createdAt: now,
    updatedAt: now,
    photos: [],
    reviews: [],
    timeline: [],
    canEdit: true,
    canReview: false,
    canFlag: false,
    isFavorited: false,
    photoLimits: { maxBytes: Number.POSITIVE_INFINITY, maxFiles: Number.POSITIVE_INFINITY },
  };
}

/** 只把非图片字段写进暂存；参与人排除创建人本人。 */
function snapshotOf(record: RepairDetailView): CreateDraftSnapshot {
  return {
    repairDate: record.repairDate,
    durationMinutes: record.durationMinutes,
    categoryId: record.category?.id ?? null,
    ownerName: record.ownerName,
    ownerPhone: record.ownerPhone,
    remark: record.remark,
    participantIds: record.participants
      .filter((participant) => participant.id !== record.member.id)
      .map((participant) => participant.id),
  };
}

export function RepairEditor({
  recordId,
  allowSaveDraft = true,
  returnActivityId,
}: {
  /**
   * 编辑既有记录时传 ID；新建页**不传**：表单先在本地填写，首次传图或提交时才建档（issue #162）。
   */
  recordId?: string;
  /** 新建流程不再暴露「草稿」（issue #72）：只留提交审核；编辑存量草稿与退回记录仍可保存。 */
  allowSaveDraft?: boolean;
  /** 从活动看板进入时，提交成功后返回该看板继续接待。 */
  returnActivityId?: string;
}) {
  const router = useRouter();
  const createMode = !recordId;
  const [serverId, setServerId] = useState(recordId ?? "");
  /** 新建会话的幂等键：重复点提交 / 上传重试都不会多建草稿。 */
  const [createRequestKey] = useState(createIdempotencyKey);
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
      if (!serverId) {
        const [catsResponse, membersResponse, meResponse] = await Promise.all([
          fetch("/api/v1/repair-categories", { cache: "no-store" }),
          fetch("/api/v1/repair-members", { cache: "no-store" }),
          fetch("/api/v1/me", { cache: "no-store" }),
        ]);
        const cats = await catsResponse.json();
        const members = await membersResponse.json();
        const me = await meResponse.json();
        if (!me.success || typeof me.data?.memberProfileId !== "string") {
          setState("error");
          return;
        }
        const options: RepairMemberOption[] = members.success ? members.data : [];
        const categories: RepairCategoryView[] = cats.success ? cats.data : [];
        setMemberOptions(options);
        setCategories(categories);
        const stored = readCreateDraft();
        const wanted = new Set(stored?.participantIds ?? []);
        const creator = {
          id: me.data.memberProfileId as string,
          name: (me.data.displayName as string | null) ?? "我",
        };
        const participants = options
          .filter((option) => wanted.has(option.id) && option.id !== creator.id)
          .map((option) => ({ id: option.id, name: option.name }));
        setRecord(localDraftRecord({ creator, categories, participants, stored }));
        if (stored && hasCreateDraftContent(stored))
          setMessage(repairEditorCopy.createDraftRestored);
        setState("ready");
        return;
      }
      const [a, b, c] = await Promise.all([
        fetch(`/api/v1/repairs/${serverId}`, { cache: "no-store" }),
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
  }, [serverId]);
  useEffect(() => {
    void load();
  }, [load]);
  // 新建页：非图片字段随时写进 sessionStorage；有内容时关闭 / 刷新给出浏览器提醒。
  useEffect(() => {
    if (!createMode || serverId || !record) return;
    const snapshot = snapshotOf(record);
    if (hasCreateDraftContent(snapshot)) writeCreateDraft(snapshot);
    else clearCreateDraft();
  }, [createMode, serverId, record]);
  useEffect(() => {
    if (!createMode || serverId || !record) return;
    if (!hasCreateDraftContent(snapshotOf(record))) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [createMode, serverId, record]);
  function field<K extends keyof RepairDetailView>(key: K, value: RepairDetailView[K]) {
    setRecord((current) => (current ? { ...current, [key]: value } : current));
  }
  /** 保存当前表单，返回服务端视图 —— `PATCH` 返回的是列表视图（无 `reviews` / `timeline`），故用合并。 */
  async function persist(): Promise<RepairDetailView> {
    if (!record) throw new Error("记录尚未加载");
    const fields = {
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
    };
    if (!serverId) {
      // 新建页首次落库：把当前全部内容一次性带上（不再先建空草稿）。
      const response = await fetch("/api/v1/repairs", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": createRequestKey },
        body: JSON.stringify(fields),
      });
      const json = await response.json();
      if (!json.success) throw new Error(json.error.message);
      clearCreateDraft();
      setServerId(json.data.id);
      setRecord((current) => (current ? { ...current, ...json.data } : json.data));
      return { ...record, ...json.data } as RepairDetailView;
    }
    const response = await fetch(`/api/v1/repairs/${serverId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: record.version, ...fields }),
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
      const response = await fetch(`/api/v1/repairs/${saved.id}/submit`, {
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
      clearCreateDraft();
      if (returnActivityId) {
        setToast({ text: repairEditorCopy.activitySubmitSuccess, tone: "success" });
        setSubmitted(true);
      } else {
        router.replace(`/member/repairs/${saved.id}`);
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
  async function refreshPhotos(targetId: string) {
    const response = await fetch(`/api/v1/repairs/${targetId}`, { cache: "no-store" });
    const json = await response.json();
    if (!json.success) return;
    setRecord((current) => (current ? { ...current, photos: json.data.photos } : current));
  }
  async function upload(files: File[]) {
    if (!files.length || !record) return;
    const selected = files;
    setBusy(true);
    setMessage("");
    try {
      // 新建页首次传图：先把全部内容一次性落成服务端草稿（照片接口挂在记录 ID 上）。
      let targetId = serverId;
      let current = record;
      if (!targetId) {
        current = await persist();
        targetId = current.id;
        const detail = await fetch(`/api/v1/repairs/${targetId}`, { cache: "no-store" });
        const detailJson = await detail.json();
        if (!detailJson.success) throw new Error(detailJson.error.message);
        current = detailJson.data as RepairDetailView;
        setRecord(current);
      }
      const { maxBytes, maxFiles } = current.photoLimits;
      // 按服务端下发的上限拦一遍：超限的文件根本传不上去，不必等 multipart 走完再说。
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
      if (current.photos.length + selected.length > maxFiles) {
        setMessage(
          repairEditorCopy.photoTooMany
            .replace("{count}", String(current.photos.length))
            .replace("{remain}", String(Math.max(maxFiles - current.photos.length, 0))),
        );
        return;
      }
      const form = new FormData();
      selected.forEach((file) => form.append("photos", file));
      const response = await fetch(`/api/v1/repairs/${targetId}/photos`, {
        method: "POST",
        body: form,
      });
      const json = await response.json();
      if (!json.success) throw new Error(json.error.message);
      await refreshPhotos(targetId);
      setMessage("照片已上传。");
      // 建档后离开新建页：地址里带记录 ID，刷新不会丢关联，活动看板的「填写维修记录」也指向它。
      if (createMode) router.replace(`/member/repairs/${targetId}/edit`);
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
      await refreshPhotos(serverId);
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
    await refreshPhotos(serverId);
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
  const photoHint =
    createMode && !serverId
      ? repairEditorCopy.photoHintCreate
      : repairEditorCopy.photoHint
          .replace("{size}", formatBytes(record.photoLimits.maxBytes))
          .replace("{count}", String(record.photoLimits.maxFiles));
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
          <RepairParticipantPicker
            creatorId={record.member.id}
            participants={record.participants}
            options={memberOptions}
            disabled={busy}
            onAdd={addParticipant}
            onRemove={removeParticipant}
          />
          <p className="field__hint">
            {allowSaveDraft ? repairEditorCopy.requiredNote : repairEditorCopy.requiredNoteCreate}
          </p>
          <p className="field__hint">
            维修结果默认为「{repairResultLabels[defaultRepairResult]}」，保存与提交都会按此记录。
          </p>
          {serverId ? <p className="field__hint">当前版本：{record.version}</p> : null}
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
