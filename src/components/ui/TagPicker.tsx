"use client";

import { MEMBER_SKILL_LIMIT, type SkillView } from "@/types/contracts";

/** 标签选择器：已选项可移除，候选项可添加，达到上限后禁用未选项。 */
export type TagPickerLabels = {
  empty: string;
  /** `{count}` 替换成剩余可选数量。 */
  remaining: string;
  /** `{name}` 替换成标签名，用于单个标签移除按钮的无障碍名称。 */
  remove: string;
  inactive: string;
  /** `{limit}` 替换成上限；只在达到上限时显示。 */
  limitReached: string;
};

export function TagPicker({
  options,
  selectedIds,
  onChange,
  labels,
  disabled = false,
  limit = MEMBER_SKILL_LIMIT,
}: {
  options: readonly SkillView[];
  selectedIds: readonly string[];
  onChange: (next: string[]) => void;
  labels: TagPickerLabels;
  disabled?: boolean;
  limit?: number;
}) {
  const selected = new Set(selectedIds);
  const remaining = Math.max(0, limit - selected.size);
  const atLimit = remaining === 0;
  const selectedTags = options.filter((option) => selected.has(option.id));

  function toggle(skillId: string) {
    if (disabled) return;
    if (selected.has(skillId)) {
      onChange(selectedIds.filter((id) => id !== skillId));
      return;
    }
    if (atLimit) return;
    onChange([...selectedIds, skillId]);
  }

  if (options.length === 0) return <p className="admin-note">{labels.empty}</p>;

  return (
    <div className="tagpicker">
      {/* 上半部分模拟一个输入框：装已选标签，右侧显示剩余额度。 */}
      <div className="tagpicker__box" data-disabled={disabled || undefined}>
        <div className="tagpicker__selected">
          {selectedTags.length === 0 ? (
            <span className="tagpicker__placeholder">{labels.empty}</span>
          ) : (
            selectedTags.map((tag) => (
              <span className="tagpicker__chip" key={tag.id}>
                {tag.name}
                {!tag.isActive ? (
                  <small className="tagpicker__chip-status">{labels.inactive}</small>
                ) : null}
                <button
                  type="button"
                  className="tagpicker__chip-remove"
                  disabled={disabled}
                  aria-label={labels.remove.replace("{name}", tag.name)}
                  onClick={() => toggle(tag.id)}
                >
                  ×
                </button>
              </span>
            ))
          )}
        </div>
        <span className="tagpicker__remaining" role="status" aria-live="polite">
          {labels.remaining.replace("{count}", String(remaining))}
        </span>
      </div>

      {/* 候选一行铺开：已选中的高亮，再点一次即取消（与上半部分等价，两处都能操作）。 */}
      <div className="tagpicker__options" role="group">
        {options.map((option) => {
          const isSelected = selected.has(option.id);
          return (
            <button
              key={option.id}
              type="button"
              className="tagpicker__option"
              aria-pressed={isSelected}
              disabled={disabled || (atLimit && !isSelected)}
              onClick={() => toggle(option.id)}
            >
              {option.name}
            </button>
          );
        })}
      </div>

      {atLimit ? (
        <p className="admin-note" role="status" aria-live="polite">
          {labels.limitReached.replace("{limit}", String(limit))}
        </p>
      ) : null}
    </div>
  );
}
