import type { RegistrationPublicView } from "./repair-activity-service";

/** 设备状态查询的超时：设备接口卡住时最多等这么久，随后按「未知」放开报名表单。 */
export const REGISTRATION_DEVICE_STATUS_TIMEOUT_MS = 8_000;

type DeviceStatusResponse = {
  success: boolean;
  data?: { registration: RegistrationPublicView | null };
};

/**
 * `AbortSignal.timeout` 的兜底（Chrome 103+ / Safari 16.4+ 已有，这里只防极端环境）。
 * 任何构造异常都由调用方的 try 兜住。
 */
function createTimeoutSignal(timeoutMs: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("Timeout", "TimeoutError")),
    timeoutMs,
  );
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return controller.signal;
}

/**
 * `AbortSignal.any` 需要 Chrome 116 / Firefox 124 / Safari 17.4，低于 Next 15 的浏览器基线；
 * iOS 16 上的 Safari 16.x 没有它。缺失时手动合并，避免整个查询直接抛错。
 */
function combineSignals(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/**
 * 读取本设备的报名状态（公开、只读）。
 *
 * 契约：**不抛错**。超时 / 网络 / 服务端异常 / 旧浏览器缺 AbortSignal API 一律返回 undefined，
 * 调用方据此放开报名表单：设备状态只用来优化入口，不能因为接口或环境问题让用户看不到表单。
 */
export async function fetchRegistrationDeviceStatus(
  activityId: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<RegistrationPublicView | null | undefined> {
  try {
    const timeout = createTimeoutSignal(options.timeoutMs ?? REGISTRATION_DEVICE_STATUS_TIMEOUT_MS);
    const signal = options.signal ? combineSignals([options.signal, timeout]) : timeout;
    const response = await fetch(`/api/v1/repair-activities/${activityId}/registrations/device`, {
      signal,
    });
    const json = (await response.json()) as DeviceStatusResponse;
    if (!json.success) return undefined;
    return json.data?.registration ?? null;
  } catch {
    return undefined;
  }
}
