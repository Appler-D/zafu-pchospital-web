"use client";

import { RepairEditor } from "./RepairEditor";

/**
 * 新建维修记录：点进来就是表单（issue #72），没有「先建草稿再编辑」的中间步。
 *
 * issue #162 起**进页面不建档**：非图片内容暂存在 sessionStorage，首次传图或提交时才落库，
 * 因此反复进出不会留下一串空草稿；刷新 / 站内跳走可恢复，提交成功后清除暂存。
 */
export function CreateRepairForm() {
  return <RepairEditor allowSaveDraft={false} />;
}
