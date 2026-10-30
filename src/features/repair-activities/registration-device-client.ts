import type { RegistrationPublicView } from "./repair-activity-service";

/** 设备状态查询的超时：设备接口卡住时最多等这么久，随后按「未知」放开报名表单。 */
export const REGISTRATION_DEVICE_STATUS_TIMEOUT_MS = 8_000;

type DeviceStatusResponse = {
  success: boolean;
  data?: { registration: RegistrationPublicView | null };
};

/**
 * 读取本设备的报名状态（公开、只读）。
 *
 * 超时 / 网络 / 服务端异常一律返回 undefined，调用方据此放开报名表单：
 * 设备状态只用来优化入口，不能因为接口卡住让用户永远看不到报名表单。
 */
export async function fetchRegistrationDeviceStatus(
  activityId: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<RegistrationPublicView | null | undefined> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? REGISTRATION_DEVICE_STATUS_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
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
