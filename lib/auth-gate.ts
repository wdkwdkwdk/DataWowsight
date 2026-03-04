import { createHash } from "crypto";

export const ACCESS_COOKIE_NAME = "dw_access_token";
const ACCESS_PASSWORD_ENV = "APP_ACCESS_PASSWORD";

export function getConfiguredAccessPassword() {
  const raw = process.env[ACCESS_PASSWORD_ENV];
  return raw && raw.trim().length > 0 ? raw.trim() : "";
}

export function isAccessGateEnabled() {
  return getConfiguredAccessPassword().length > 0;
}

export function buildAccessTokenFromPassword(password: string) {
  return createHash("sha256").update(`datawowsight:${password}`).digest("hex");
}

export function getExpectedAccessToken() {
  const password = getConfiguredAccessPassword();
  if (!password) return "";
  return buildAccessTokenFromPassword(password);
}
