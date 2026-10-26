import type { BoardReadState } from "./board-reader";
import { memberRepairActivitiesCopy } from "@/config/repair-activities";

const time = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export function BoardSyncStatus({
  label,
  state,
}: {
  label: string;
  state: BoardReadState<unknown>;
}) {
  const copy = memberRepairActivitiesCopy.board;
  const warning = state.stopped
    ? copy.syncStopped
    : state.failures > 0 && state.lastSuccessAt === null
      ? copy.syncInitialFailure
      : state.failures > 1
        ? copy.syncRepeatedFailure
        : state.failures > 0
          ? copy.syncFailure
          : "";
  return (
    <div className="activity-board__sync">
      <span>
        {label} ·{" "}
        {state.lastSuccessAt === null ? (
          copy.syncNever
        ) : (
          <time dateTime={new Date(state.lastSuccessAt).toISOString()}>
            {time.format(state.lastSuccessAt)}
          </time>
        )}
      </span>
      <span
        className={warning ? "activity-board__sync-warning" : ""}
        role={warning ? "status" : undefined}
      >
        {warning ||
          (state.pending ? copy.syncing : state.lastSuccessAt === null ? "" : copy.syncReady)}
      </span>
    </div>
  );
}
