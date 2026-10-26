"use client";

import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { repairEditorCopy as copy, repairFieldLimits } from "@/config/repairs";
import { matchesRepairMemberKeyword } from "@/features/repairs/repair-member-search";
import { cn } from "@/lib/utils";
import type { RepairMemberOption } from "@/types/contracts";

/**
 * 成员编辑器与后台共用；已选区高度固定，增删人员不挤动下方表单。
 * 活动接待建单传 `scope="attendance"`：候选仅本场出勤成员，姓名/昵称均可搜索。
 */
export function RepairParticipantPicker({
  creatorId,
  participants,
  options,
  disabled = false,
  scope = "all",
  onAdd,
  onRemove,
}: {
  creatorId: string;
  participants: readonly RepairMemberOption[];
  options: readonly RepairMemberOption[];
  disabled?: boolean;
  scope?: "all" | "attendance";
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const addable = options.filter(
    (option) => option.id !== creatorId && !participants.some((item) => item.id === option.id),
  );
  const full = participants.length >= repairFieldLimits.participantMaxCount;
  const unavailable = disabled || full || addable.length === 0;
  const attendanceScope = scope === "attendance";
  const labels = attendanceScope
    ? {
        add: copy.participantsAttendanceAddLabel,
        placeholder: copy.participantsAttendancePlaceholder,
        noMatches: copy.participantsAttendanceNoMatches,
        noOptions: copy.participantsAttendanceNoOptions,
        hint: copy.participantsAttendanceHint,
      }
    : {
        add: copy.participantsAddLabel,
        placeholder: copy.participantsAddPlaceholder,
        noMatches: copy.participantsNoMatches,
        noOptions: copy.participantsNoOptions,
        hint: copy.participantsHint,
      };
  const matches = addable.filter((member) => matchesRepairMemberKeyword(member, query));
  const expanded = open && !unavailable && query.trim().length > 0;
  const activeMember = matches[activeIndex];

  function selectMember(member: RepairMemberOption) {
    if (unavailable) return;
    onAdd(member.id);
    setQuery("");
    setActiveIndex(0);
    inputRef.current?.focus({ preventScroll: true });
    setOpen(false);
  }

  function moveActive(index: number) {
    setActiveIndex(index);
    const menu = menuRef.current;
    const option = menu?.children[index] as HTMLElement | undefined;
    if (!menu || !option) return;
    if (option.offsetTop < menu.scrollTop) menu.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > menu.scrollTop + menu.clientHeight)
      menu.scrollTop = option.offsetTop + option.offsetHeight - menu.clientHeight;
  }

  return (
    <div className="repair-participants" role="group" aria-labelledby={`${id}-label`}>
      <div className="repair-participants__head">
        <span className="field__label" id={`${id}-label`}>
          <Icon name="users" />
          {copy.participantsLabel}
        </span>
        <span className="repair-participants__count" role="status">
          {copy.participantsCount
            .replace("{count}", String(participants.length))
            .replace("{limit}", String(repairFieldLimits.participantMaxCount))}
        </span>
      </div>
      <ul className="repair-participants__selected" aria-labelledby={`${id}-label`}>
        {participants.map((participant) => {
          const isCreator = participant.id === creatorId;
          return (
            <li
              className={cn(
                "repair-participants__chip",
                isCreator && "repair-participants__chip--creator",
              )}
              key={participant.id}
            >
              <span className="repair-participants__identity">
                <span className="repair-participants__name" title={participant.name}>
                  {participant.name}
                </span>
                {isCreator ? (
                  <span className="repair-participants__creator">
                    {copy.participantsCreatorTag}
                  </span>
                ) : null}
              </span>
              {isCreator ? null : (
                <Button
                  className="repair-participants__remove"
                  icon="close"
                  disabled={disabled}
                  aria-label={copy.participantsRemoveLabel.replace("{name}", participant.name)}
                  onClick={() => onRemove(participant.id)}
                >
                  <span className="sr-only">{copy.participantsRemove}</span>
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      <div
        className="repair-participants__search"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
        }}
      >
        <Icon name="filter" className="repair-participants__search-icon" />
        <input
          ref={inputRef}
          className="field__input repair-participants__input"
          type="text"
          role="combobox"
          autoComplete="off"
          value={query}
          disabled={unavailable}
          placeholder={
            full
              ? copy.participantsLimit
              : addable.length === 0
                ? labels.noOptions
                : labels.placeholder
          }
          aria-label={labels.add}
          aria-describedby={`${id}-hint`}
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={expanded ? `${id}-options` : undefined}
          aria-activedescendant={
            expanded && activeMember ? `${id}-option-${activeMember.id}` : undefined
          }
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
            setOpen(true);
            if (menuRef.current) menuRef.current.scrollTop = 0;
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape" && expanded) {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
            } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              if (!query.trim() || matches.length === 0) return;
              event.preventDefault();
              setOpen(true);
              moveActive(
                !expanded
                  ? event.key === "ArrowDown"
                    ? 0
                    : matches.length - 1
                  : (activeIndex + (event.key === "ArrowDown" ? 1 : -1) + matches.length) %
                      matches.length,
              );
            } else if (event.key === "Enter") {
              // 搜索框里的回车只用于选择，不能意外提交整个维修表单。
              event.preventDefault();
              if (expanded && activeMember) selectMember(activeMember);
            }
          }}
        />
        {expanded ? (
          <div className="repair-participants__menu">
            <p className="repair-participants__results" role="status">
              {matches.length
                ? copy.participantsMatches.replace("{count}", String(matches.length))
                : labels.noMatches}
            </p>
            <ul ref={menuRef} id={`${id}-options`} role="listbox" aria-label={labels.add}>
              {matches.map((member, index) => (
                <li key={member.id} role="presentation">
                  <button
                    id={`${id}-option-${member.id}`}
                    className={cn(
                      "repair-participants__option",
                      index === activeIndex && "repair-participants__option--active",
                    )}
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    tabIndex={-1}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectMember(member)}
                  >
                    <span>{member.name}</span>
                    <Icon name="plus" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <span className="field__hint" id={`${id}-hint`}>
        {labels.hint}
      </span>
    </div>
  );
}
