import { createHash, randomUUID } from "node:crypto";
import { appendAuditLog } from "@/lib/audit/audit-service";
import { AppError } from "@/lib/api/errors";
import { formatBytes } from "@/config/repairs";
import type { Prisma } from "@/generated/prisma/client";
import { getDb } from "@/lib/db/client";
import { inSerializableTransaction } from "@/lib/db/transaction";
import { assertCanAttachRepairPhotos, assertCanReadRepair } from "./repair-policy";
import { repairRepository } from "./repair-repository";
import { timeline } from "./repair-service";
import {
  localRepairPhotoStorage,
  type RepairPhotoStorage,
  uploadLimits,
} from "./repair-photo-storage";
import type { AuthorizedActor, RepairPhotoView } from "@/types/contracts";

export function createRepairPhotoService(storage: RepairPhotoStorage) {
  return {
    async upload(
      recordId: string,
      files: File[],
      actor: AuthorizedActor,
    ): Promise<RepairPhotoView[]> {
      const record = await repairRepository.getById(recordId);
      assertCanAttachRepairPhotos(actor, record);
      const limits = uploadLimits();
      if (!files.length) throw new AppError("VALIDATION_FAILED", "请选择照片");
      // 快照预检先挡住明显超限的请求，避免读文件和落盘；并发下仍以锁后复核为准。
      if (record.photos.length + files.length > limits.maxFiles)
        throw new AppError(
          "REPAIR_PHOTO_LIMIT_EXCEEDED",
          `每条记录最多上传 ${limits.maxFiles} 张照片`,
        );
      const prepared = await Promise.all(
        files.map(async (file) => {
          if (file.size > limits.maxBytes)
            throw new AppError(
              "REPAIR_PHOTO_TOO_LARGE",
              `「${file.name}」${formatBytes(file.size)}，超过单张 ${formatBytes(limits.maxBytes)} 的上限`,
            );
          const bytes = new Uint8Array(await file.arrayBuffer());
          const detected = detectImageType(bytes);
          if (!detected || detected !== file.type)
            throw new AppError(
              "REPAIR_PHOTO_TYPE_UNSUPPORTED",
              "仅支持真实的 JPEG、PNG 或 WebP 图片",
            );
          return {
            file,
            bytes,
            mimeType: detected,
            digest: createHash("sha256").update(bytes).digest(),
          };
        }),
      );
      const stored: Array<{ storageKey: string; item: (typeof prepared)[number] }> = [];
      try {
        for (const item of prepared) stored.push({ ...(await storage.put(item)), item });
        const now = new Date();
        const created = await inSerializableTransaction(async (tx) => {
          // 审核与补附件可能并发：锁记录行后复核状态和实际照片数，避免审核通过后照片才落库。
          const locked = await lockRecordForPhotoMutation(tx, recordId);
          assertCanAttachRepairPhotos(actor, locked);
          if (locked.photos.length + stored.length > limits.maxFiles)
            throw new AppError(
              "REPAIR_PHOTO_LIMIT_EXCEEDED",
              `每条记录最多上传 ${limits.maxFiles} 张照片`,
            );
          const rows = [];
          for (const [index, entry] of stored.entries()) {
            rows.push(
              await tx.repairPhoto.create({
                data: {
                  id: randomUUID(),
                  repairRecordId: recordId,
                  storageKey: entry.storageKey,
                  originalName: entry.item.file.name.slice(0, 255) || null,
                  mimeType: entry.item.mimeType,
                  sizeBytes: entry.item.bytes.byteLength,
                  sha256Digest: entry.item.digest,
                  sortOrder: locked.photos.length + index,
                  uploadedByUserId: actor.userId!,
                  createdAt: now,
                },
              }),
            );
          }
          await timeline(
            tx,
            recordId,
            actor.userId,
            "PHOTO_ADDED",
            { count: rows.length, photoIds: rows.map((row) => row.id) },
            now,
          );
          return rows;
        });
        return created.map(view);
      } catch (error) {
        await Promise.allSettled(stored.map((entry) => storage.delete(entry.storageKey)));
        if (error instanceof AppError) throw error;
        throw new AppError("REPAIR_PHOTO_STORAGE_FAILED", "照片保存失败", { cause: error });
      }
    },

    async remove(recordId: string, photoId: string, actor: AuthorizedActor): Promise<void> {
      const record = await repairRepository.getById(recordId);
      assertCanAttachRepairPhotos(actor, record);
      const photo = record.photos.find((item) => item.id === photoId);
      if (!photo) throw new AppError("REPAIR_NOT_FOUND", "照片不存在");
      await inSerializableTransaction(async (tx) => {
        const locked = await lockRecordForPhotoMutation(tx, recordId);
        assertCanAttachRepairPhotos(actor, locked);
        if (!locked.photos.some((item) => item.id === photoId))
          throw new AppError("REPAIR_NOT_FOUND", "照片不存在");
        await tx.repairPhoto.update({ where: { id: photoId }, data: { deletedAt: new Date() } });
        await timeline(tx, recordId, actor.userId, "PHOTO_REMOVED", { photoId }, new Date());
      });
    },

    async reorder(
      recordId: string,
      photoId: string,
      sortOrder: number,
      actor: AuthorizedActor,
    ): Promise<RepairPhotoView> {
      if (!Number.isInteger(sortOrder) || sortOrder < 0)
        throw new AppError("VALIDATION_FAILED", "照片顺序无效");
      const record = await repairRepository.getById(recordId);
      assertCanAttachRepairPhotos(actor, record);
      const current = record.photos.find((item) => item.id === photoId);
      if (!current) throw new AppError("REPAIR_NOT_FOUND", "照片不存在");
      const target = record.photos[sortOrder];
      if (!target) throw new AppError("VALIDATION_FAILED", "照片顺序无效");
      const updated = await inSerializableTransaction(async (tx) => {
        const locked = await lockRecordForPhotoMutation(tx, recordId);
        assertCanAttachRepairPhotos(actor, locked);
        const lockedCurrent = locked.photos.find((item) => item.id === photoId);
        const lockedTarget = locked.photos[sortOrder];
        if (!lockedCurrent || !lockedTarget)
          throw new AppError("VALIDATION_FAILED", "照片顺序无效");
        if (lockedTarget.id !== photoId)
          await tx.repairPhoto.update({
            where: { id: lockedTarget.id },
            data: { sortOrder: lockedCurrent.sortOrder },
          });
        const photo = await tx.repairPhoto.update({
          where: { id: photoId },
          data: { sortOrder },
        });
        await timeline(
          tx,
          recordId,
          actor.userId,
          "UPDATED",
          { fields: ["photos.sortOrder"], photoId, sortOrder },
          new Date(),
        );
        return photo;
      });
      return view(updated);
    },

    async open(photoId: string, actor: AuthorizedActor) {
      const photo = await getDb().repairPhoto.findFirst({
        where: { id: photoId, deletedAt: null },
        include: { record: { include: { memberProfile: true } } },
      });
      if (!photo || photo.record.deletedAt) throw new AppError("REPAIR_NOT_FOUND", "照片不存在");
      assertCanReadRepair(actor, photo.record);
      try {
        const bytes = await storage.open(photo.storageKey);
        if (bytes.byteLength !== photo.sizeBytes) throw new Error("stored photo size mismatch");
        return { photo, bytes };
      } catch (error) {
        await inSerializableTransaction((tx) =>
          appendAuditLog(tx, {
            actor,
            actorType: "USER",
            actorUserId: actor.userId,
            action: "repair.photo.storage_failed",
            targetType: "RepairPhoto",
            targetId: photo.id,
            result: "FAILURE",
            errorCode: "REPAIR_PHOTO_STORAGE_FAILED",
          }),
        );
        throw new AppError("REPAIR_PHOTO_STORAGE_FAILED", "照片暂时不可读取", { cause: error });
      }
    },
  };
}

export const repairPhotoService = createRepairPhotoService(localRepairPhotoStorage);

/**
 * 锁定维修记录并按真实状态复核照片权限。
 *
 * 审核服务更新同一行状态；这里先 `FOR UPDATE` 再读，保证「审核已通过」不会被并发补传绕过。
 */
async function lockRecordForPhotoMutation(tx: Prisma.TransactionClient, recordId: string) {
  await tx.$queryRaw`SELECT id FROM repair_records WHERE id = ${recordId} FOR UPDATE`;
  const record = await tx.repairRecord.findFirst({
    where: { id: recordId, deletedAt: null },
    include: {
      memberProfile: true,
      photos: {
        where: { deletedAt: null },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        select: { id: true, sortOrder: true },
      },
    },
  });
  if (!record) throw new AppError("REPAIR_NOT_FOUND", "维修记录不存在");
  return record;
}

export function detectImageType(
  bytes: Uint8Array,
): "image/jpeg" | "image/png" | "image/webp" | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes
      .slice(0, 8)
      .every((value, index) => value === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][index])
  )
    return "image/png";
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  )
    return "image/webp";
  return null;
}
function view(photo: {
  id: string;
  originalName: string | null;
  mimeType: string;
  sizeBytes: number;
  sortOrder: number;
  createdAt: Date;
}): RepairPhotoView {
  return {
    id: photo.id,
    contentUrl: `/api/v1/repair-photos/${photo.id}/content`,
    originalName: photo.originalName,
    mimeType: photo.mimeType,
    sizeBytes: photo.sizeBytes,
    sortOrder: photo.sortOrder,
    createdAt: photo.createdAt.toISOString(),
  };
}
