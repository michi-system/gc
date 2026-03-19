import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const APP_PORT = Number(process.env.PORT ?? "3141");
export const BASE_URL = process.env.BASE_URL ?? `http://127.0.0.1:${APP_PORT}`;
export const APP_ROOT = fileURLToPath(new URL("../", import.meta.url));
export const DATA_DIR = process.env.GC_GREENFIELD_DATA_DIR ?? join(APP_ROOT, ".local");
export const USERS_DIR = join(DATA_DIR, "users");
export const PUBLIC_DIR = join(APP_ROOT, "public");
export const CONFIG_PATH = join(DATA_DIR, "config.json");
export const AUTOFILL_PROFILE_DIR = join(DATA_DIR, "playwright-profile");

function resolveChromeExecutablePath(): string {
  if (process.env.GC_GREENFIELD_CHROME_PATH) {
    return process.env.GC_GREENFIELD_CHROME_PATH;
  }

  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ];
  return candidates.find((path) => existsSync(path)) ?? candidates[0];
}

export const CHROME_EXECUTABLE_PATH = resolveChromeExecutablePath();
export const OAUTH_DIR = join(DATA_DIR, "oauth");
export const GMAIL_TOKENS_DIR = join(DATA_DIR, "oauth", "gmails");
export const CALENDAR_TOKENS_DIR = join(DATA_DIR, "oauth", "calendars");
export const CREDENTIALS_JSON_PATH = join(OAUTH_DIR, "client_secret.json");
export const STALE_NOTIFICATIONS_PATH = join(DATA_DIR, "stale-notifications.json");
export const RUNTIME_STATE_PATH = join(DATA_DIR, "runtime-state.json");

export function userDataDir(userId: string): string {
  return join(USERS_DIR, userId);
}

export function userConfigPath(userId: string): string {
  return join(userDataDir(userId), "config.json");
}

export function userRuntimeStatePath(userId: string): string {
  return join(userDataDir(userId), "runtime-state.json");
}

export function userOauthDir(userId: string): string {
  return join(userDataDir(userId), "oauth");
}

export function userGmailTokensDir(userId: string): string {
  return join(userOauthDir(userId), "gmails");
}

export function userCalendarTokensDir(userId: string): string {
  return join(userOauthDir(userId), "calendars");
}

export function userAutofillProfileDir(userId: string): string {
  return join(userDataDir(userId), "playwright-profile");
}

export function userStaleNotificationsPath(userId: string): string {
  return join(userDataDir(userId), "stale-notifications.json");
}
