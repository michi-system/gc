import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  CALENDAR_TOKENS_DIR,
  CONFIG_PATH,
  DATA_DIR,
  GMAIL_TOKENS_DIR,
  OAUTH_DIR,
  RUNTIME_STATE_PATH,
  USERS_DIR,
  userCalendarTokensDir,
  userConfigPath,
  userDataDir,
  userGmailTokensDir,
  userOauthDir,
  userRuntimeStatePath,
} from "./env.js";
import type {
  AppConfig,
  AutofillTaskRecord,
  GoogleAccountConfig,
  ReconciliationOverrideRecord,
  RuntimeStateStore,
  StudentCodeDirectoryEntry,
  StudentRoutineProfile,
} from "./types.js";

export const DEFAULT_CONFIG: AppConfig = {
  timezone: "Asia/Tokyo",
  coachProfile: {
    name: "",
    code: "",
    email: "",
  },
  googleOAuth: {
    clientCredentialsPath: "",
  },
  googleAccounts: {
    gmails: [],
    calendars: [],
  },
};

export function ensureStorage(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(USERS_DIR, { recursive: true });
  mkdirSync(OAUTH_DIR, { recursive: true });
  mkdirSync(GMAIL_TOKENS_DIR, { recursive: true });
  mkdirSync(CALENDAR_TOKENS_DIR, { recursive: true });
}

function normalizeConfig(raw: Partial<AppConfig> | null | undefined): AppConfig {
  return {
    timezone: raw?.timezone || DEFAULT_CONFIG.timezone,
    coachProfile: {
      name: raw?.coachProfile?.name || "",
      code: raw?.coachProfile?.code || "",
      email: raw?.coachProfile?.email || "",
    },
    googleOAuth: {
      clientCredentialsPath: raw?.googleOAuth?.clientCredentialsPath || "",
    },
    googleAccounts: {
      gmails: Array.isArray(raw?.googleAccounts?.gmails) ? raw!.googleAccounts!.gmails : [],
      calendars: Array.isArray(raw?.googleAccounts?.calendars) ? raw!.googleAccounts!.calendars : [],
    },
  };
}

function normalizeRuntimeState(raw: Partial<RuntimeStateStore> | null | undefined): RuntimeStateStore {
  const autofillTasks = Object.fromEntries(
    Object.entries(raw?.autofillTasks ?? {}).map(([id, task]) => [
      id,
      task?.status === "submitted_confirmed" || task?.status === "autofill_running"
        ? { ...task, status: "awaiting_user_submit" }
        : task,
    ]),
  ) as RuntimeStateStore["autofillTasks"];
  return {
    reconciliationOverrides: raw?.reconciliationOverrides ?? {},
    invalidatedSubmissionIds: Array.isArray(raw?.invalidatedSubmissionIds) ? raw!.invalidatedSubmissionIds : [],
    autofillTasks,
    studentCodeDirectory: raw?.studentCodeDirectory ?? {},
    studentRoutineProfiles: raw?.studentRoutineProfiles ?? {},
  };
}

function ensureUserStorage(userId: string): void {
  ensureStorage();
  mkdirSync(userDataDir(userId), { recursive: true });
  mkdirSync(userOauthDir(userId), { recursive: true });
  mkdirSync(userGmailTokensDir(userId), { recursive: true });
  mkdirSync(userCalendarTokensDir(userId), { recursive: true });
}

function hasSeedableEmptyUserState(userId: string): boolean {
  const configPath = userConfigPath(userId);
  const runtimePath = userRuntimeStatePath(userId);
  const hasGmailTokens = existsSync(userGmailTokensDir(userId)) && readdirSync(userGmailTokensDir(userId)).length > 0;
  const hasCalendarTokens = existsSync(userCalendarTokensDir(userId)) && readdirSync(userCalendarTokensDir(userId)).length > 0;
  if (hasGmailTokens || hasCalendarTokens) {
    return false;
  }

  if (existsSync(configPath)) {
    const current = normalizeConfig(JSON.parse(readFileSync(configPath, "utf8")) as Partial<AppConfig>);
    const configHasData = Boolean(
      current.coachProfile.name
      || current.coachProfile.code
      || current.coachProfile.email
      || current.googleOAuth.clientCredentialsPath
      || current.googleAccounts.gmails.length
      || current.googleAccounts.calendars.length,
    );
    if (configHasData) {
      return false;
    }
  }

  if (existsSync(runtimePath)) {
    const runtime = normalizeRuntimeState(JSON.parse(readFileSync(runtimePath, "utf8")) as Partial<RuntimeStateStore>);
    const runtimeHasData = Boolean(
      Object.keys(runtime.reconciliationOverrides).length
      || runtime.invalidatedSubmissionIds.length
      || Object.keys(runtime.autofillTasks).length
      || Object.keys(runtime.studentCodeDirectory).length
      || Object.keys(runtime.studentRoutineProfiles).length,
    );
    if (runtimeHasData) {
      return false;
    }
  }

  return existsSync(configPath) || existsSync(runtimePath);
}

function maybeSeedFromLegacyGlobalState(userId: string): void {
  const hasAnyUserState = existsSync(userConfigPath(userId))
    || existsSync(userRuntimeStatePath(userId))
    || existsSync(userGmailTokensDir(userId))
    || existsSync(userCalendarTokensDir(userId));
  if (hasAnyUserState && !hasSeedableEmptyUserState(userId)) {
    ensureUserStorage(userId);
    return;
  }
  const otherUsers = existsSync(USERS_DIR)
    ? readdirSync(USERS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name !== userId)
    : [];
  if (otherUsers.length > 0) {
    ensureUserStorage(userId);
    return;
  }
  const legacyPresent = existsSync(CONFIG_PATH) || existsSync(RUNTIME_STATE_PATH) || existsSync(OAUTH_DIR);
  if (!legacyPresent) {
    ensureUserStorage(userId);
    return;
  }
  ensureUserStorage(userId);
  if (existsSync(CONFIG_PATH)) {
    cpSync(CONFIG_PATH, userConfigPath(userId));
  }
  if (existsSync(RUNTIME_STATE_PATH)) {
    cpSync(RUNTIME_STATE_PATH, userRuntimeStatePath(userId));
  }
  if (existsSync(GMAIL_TOKENS_DIR)) {
    cpSync(GMAIL_TOKENS_DIR, userGmailTokensDir(userId), { recursive: true });
  }
  if (existsSync(CALENDAR_TOKENS_DIR)) {
    cpSync(CALENDAR_TOKENS_DIR, userCalendarTokensDir(userId), { recursive: true });
  }
  if (!existsSync(userConfigPath(userId))) {
    writeFileSync(userConfigPath(userId), JSON.stringify(DEFAULT_CONFIG, null, 2));
  }
  if (!existsSync(userRuntimeStatePath(userId))) {
    writeFileSync(userRuntimeStatePath(userId), JSON.stringify(DEFAULT_RUNTIME_STATE, null, 2));
  }
  if (existsSync(userConfigPath(userId))) {
    const seeded = normalizeConfig(JSON.parse(readFileSync(userConfigPath(userId), "utf8")) as Partial<AppConfig>);
    seeded.googleAccounts = {
      gmails: seeded.googleAccounts.gmails.map((account) => ({
        ...account,
        tokenPath: join(userGmailTokensDir(userId), `${account.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`),
      })),
      calendars: seeded.googleAccounts.calendars.map((account) => ({
        ...account,
        tokenPath: join(userCalendarTokensDir(userId), `${account.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`),
      })),
    };
    writeFileSync(userConfigPath(userId), JSON.stringify(seeded, null, 2));
  }
}

export function loadConfig(userId: string): AppConfig {
  maybeSeedFromLegacyGlobalState(userId);
  ensureUserStorage(userId);
  const configPath = userConfigPath(userId);
  if (!existsSync(configPath)) {
    saveConfig(userId, DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }

  const raw = JSON.parse(readFileSync(configPath, "utf8")) as Partial<AppConfig>;
  return normalizeConfig(raw);
}

export function saveConfig(userId: string, config: AppConfig): void {
  ensureUserStorage(userId);
  writeFileSync(userConfigPath(userId), JSON.stringify(config, null, 2));
}

export function mergeConfig(current: AppConfig, patch: Partial<AppConfig>): AppConfig {
  return {
    ...current,
    ...patch,
    coachProfile: {
      ...current.coachProfile,
      ...patch.coachProfile,
    },
    googleOAuth: {
      ...current.googleOAuth,
      ...patch.googleOAuth,
    },
    googleAccounts: {
      gmails: patch.googleAccounts?.gmails ?? current.googleAccounts.gmails,
      calendars: patch.googleAccounts?.calendars ?? current.googleAccounts.calendars,
    },
  };
}

export function upsertAccount(accounts: GoogleAccountConfig[], nextAccount: GoogleAccountConfig): GoogleAccountConfig[] {
  const index = accounts.findIndex((account) => account.id === nextAccount.id);
  if (index === -1) {
    return [...accounts, nextAccount];
  }

  const next = [...accounts];
  next[index] = nextAccount;
  return next;
}

const DEFAULT_RUNTIME_STATE: RuntimeStateStore = {
  reconciliationOverrides: {},
  invalidatedSubmissionIds: [],
  autofillTasks: {},
  studentCodeDirectory: {},
  studentRoutineProfiles: {},
};

export function loadRuntimeState(userId: string): RuntimeStateStore {
  maybeSeedFromLegacyGlobalState(userId);
  ensureUserStorage(userId);
  const runtimeStatePath = userRuntimeStatePath(userId);
  if (!existsSync(runtimeStatePath)) {
    saveRuntimeState(userId, DEFAULT_RUNTIME_STATE);
    return DEFAULT_RUNTIME_STATE;
  }

  const raw = JSON.parse(readFileSync(runtimeStatePath, "utf8")) as Partial<RuntimeStateStore>;
  return normalizeRuntimeState(raw);
}

export function saveRuntimeState(userId: string, state: RuntimeStateStore): void {
  ensureUserStorage(userId);
  writeFileSync(userRuntimeStatePath(userId), JSON.stringify(state, null, 2));
}

export function saveReconciliationOverride(userId: string, id: string, override: ReconciliationOverrideRecord): RuntimeStateStore {
  const state = loadRuntimeState(userId);
  state.reconciliationOverrides[id] = override;
  saveRuntimeState(userId, state);
  return state;
}

export function setSubmissionInvalidated(userId: string, submissionId: string, invalidated: boolean): RuntimeStateStore {
  const state = loadRuntimeState(userId);
  const next = new Set(state.invalidatedSubmissionIds);
  if (invalidated) {
    next.add(submissionId);
  } else {
    next.delete(submissionId);
  }
  state.invalidatedSubmissionIds = [...next];
  saveRuntimeState(userId, state);
  return state;
}

export function saveAutofillTask(userId: string, task: AutofillTaskRecord): RuntimeStateStore {
  const state = loadRuntimeState(userId);
  state.autofillTasks[task.id] = task;
  saveRuntimeState(userId, state);
  return state;
}

export function saveStudentCodeDirectoryEntry(userId: string, entry: StudentCodeDirectoryEntry): RuntimeStateStore {
  const state = loadRuntimeState(userId);
  state.studentCodeDirectory[entry.studentKey] = entry;
  saveRuntimeState(userId, state);
  return state;
}

export function saveStudentRoutineProfile(userId: string, entry: StudentRoutineProfile): RuntimeStateStore {
  const state = loadRuntimeState(userId);
  state.studentRoutineProfiles[entry.studentKey] = entry;
  saveRuntimeState(userId, state);
  return state;
}
