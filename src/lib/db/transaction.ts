import { setTimeout as delay } from "node:timers/promises";

import type { Prisma } from "@/generated/prisma/client";
import { getDb } from "@/lib/db/client";

const RETRYABLE_TRANSACTION_CODES = new Set(["P2034"]);

/**
 * 冲突重试的退避参数。
 *
 * 可串行化下「并发首次 INSERT 同一个索引 gap」会触发 insert-intention 死锁，P2034 是
 * **预期**结果而不是异常：立刻重试往往再次撞上同一批并发事务（观测到的就是 3 次预算
 * 用尽、原样抛出 P2034）。重试之间加**指数退避 + 抖动**，把并发事务错开即可稳定收敛。
 */
const RETRY_BASE_DELAY_MS = 10;
const RETRY_MAX_DELAY_MS = 200;

function retryDelayMs(attempt: number): number {
  const backoff = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
  return backoff + Math.floor(Math.random() * RETRY_BASE_DELAY_MS);
}

export async function inSerializableTransaction<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
  maxAttempts = 5,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await getDb().$transaction(operation, {
        isolationLevel: "Serializable",
        maxWait: 5_000,
        timeout: 15_000,
      });
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? error.code : null;
      if (
        attempt >= maxAttempts ||
        typeof code !== "string" ||
        !RETRYABLE_TRANSACTION_CODES.has(code)
      ) {
        throw error;
      }
      // 抖动退避：同步重试会让并发事务继续互相踩 gap 锁（见上方常量说明）。
      await delay(retryDelayMs(attempt));
    }
  }
}
