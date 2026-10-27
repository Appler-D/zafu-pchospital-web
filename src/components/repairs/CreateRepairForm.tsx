"use client";

import { RepairEditor } from "./RepairEditor";

/**
 * 新建维修记录：点进来就是表单，没有「先建草稿再编辑」的中间步。
 *
 *  起**进页面不建档**：非图片内容暂存在 sessionStorage，提交时才落库，
 * 因此反复进出不会留下一串空草稿；刷新 / 站内跳走可恢复，提交成功后清除暂存。
 *
 * 新建即提交（直接落 PENDING），提交前没有记录，因此不提供照片上传。
 *
 * 带 `activityId + registrationId` 时是活动接待的「继续填写」，
 * 表单从登记行预填、提交时才创建维修单并关联接待，同样不落草稿。
 */
export function CreateRepairForm({
  serveContext,
}: {
  serveContext?: { activityId: string; registrationId: string };
}) {
  return (
    <RepairEditor
      allowSaveDraft={false}
      serveContext={serveContext}
      returnActivityId={serveContext?.activityId}
    />
  );
}
