import type { RepairPhotoView } from "@/types/contracts";

/**
 * 写操作成功后的本地顺序同步：展示顺序即 0..n-1。
 *
 * 服务端已按同一不变量重排；这里只更新本地副本，避免后续上传 / 换序
 * 按旧序号重新排序时跳位。
 */
export function normalizePhotoViewOrder(photos: RepairPhotoView[]): RepairPhotoView[] {
  return photos.map((photo, index) =>
    photo.sortOrder === index ? photo : { ...photo, sortOrder: index },
  );
}
