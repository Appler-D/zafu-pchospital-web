"use client";

import { useId } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { repairEditorCopy as copy, repairFieldLimits } from "@/config/repairs";
import { cn } from "@/lib/utils";
import type { RepairMemberOption } from "@/types/contracts";

/** 成员编辑器与后台共用；已选区高度固定，增删人员不挤动下方表单。 */
export function RepairParticipantPicker({
  creatorId,
  participants,
  options,
  disabled = false,
  onAdd,
  onRemove,
}: {
  creatorId: string;
  participants: readonly RepairMemberOption[];
  options: readonly RepairMemberOption[];
  disabled?: boolean;
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const id = useId();
  const addable = options.filter(
    (option) => option.id !== creatorId && !participants.some((item) => item.id === option.id),
  );
  const full = participants.length >= repairFieldLimits.participantMaxCount;

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
      <select
        className="field__input"
        value=""
        disabled={disabled || full || addable.length === 0}
        onChange={(event) => onAdd(event.target.value)}
        aria-label={copy.participantsAddPlaceholder}
        aria-describedby={`${id}-hint`}
      >
        <option value="" disabled>
          {full
            ? copy.participantsLimit
            : addable.length === 0
              ? copy.participantsNoOptions
              : copy.participantsAddPlaceholder}
        </option>
        {addable.map((member) => (
          <option key={member.id} value={member.id}>
            {member.name}
          </option>
        ))}
      </select>
      <span className="field__hint" id={`${id}-hint`}>
        {copy.participantsHint}
      </span>
    </div>
  );
}
