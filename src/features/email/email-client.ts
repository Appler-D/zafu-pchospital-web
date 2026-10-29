import { accountEmailCopy as copy } from "@/config/account-email";
import { sessionMutationFetch } from "@/lib/auth/client-session";
/** 保留本站错误信封的业务码，供邮箱页区分发信与预占前拒绝。 */
export class EmailRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EmailRequestError";
  }
}
/** 本页不使用 adminFetch 的短时缓存：邮箱/豁免期限以服务端实时状态为准。 */
export async function emailFetch<T>(path: string, body?: unknown): Promise<T> {
  const changesSession =
    body !== undefined &&
    (path === "/api/v1/account/email/confirm" || path === "/api/v1/auth/password-reset/confirm");
  const response = await (changesSession ? sessionMutationFetch : fetch)(path, {
    method: body === undefined ? "GET" : "POST",
    cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  if (!json.success)
    throw new EmailRequestError(
      json.error?.code ?? "UNKNOWN_ERROR",
      json.error?.message ?? copy.failed,
    );
  return json.data as T;
}
