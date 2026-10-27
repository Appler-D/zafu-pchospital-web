/** 设置密码时共用的长度限制；登录只校验非空与上限，以兼容已有密码。 */
export const PASSWORD_MIN_LENGTH = 6;
export const PASSWORD_MAX_LENGTH = 128;

/** 长度是否合规。三处校验都走它，避免各写各的边界。 */
export function isPasswordLengthValid(password: string): boolean {
  return password.length >= PASSWORD_MIN_LENGTH && password.length <= PASSWORD_MAX_LENGTH;
}

/** 不合规时的统一提示（服务端返回给前端的原话）。 */
export function passwordLengthMessage(): string {
  return `密码长度必须为 ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} 个字符`;
}
