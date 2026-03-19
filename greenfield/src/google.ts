import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { google } from "googleapis";

import { APP_ROOT, BASE_URL, CREDENTIALS_JSON_PATH, userCalendarTokensDir, userGmailTokensDir } from "./env.js";
import type { AppConfig, AuthenticatedUser, GoogleAccountConfig, GoogleAuthPurpose } from "./types.js";

const GOOGLE_SCOPES_BY_PURPOSE: Record<GoogleAuthPurpose, string[]> = {
  login: [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
  ],
  gmail: [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/userinfo.email",
  ],
  calendar: [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/userinfo.email",
  ],
};

interface GoogleCredentialsFile {
  installed?: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
  web?: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
}

function sanitizeAccountId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function buildGoogleAccountId(purpose: GoogleAuthPurpose, email: string): string {
  const normalized = sanitizeAccountId(email.toLowerCase());
  return `${purpose}-${normalized || randomUUID()}`;
}

function resolveCredentialsPath(config?: Partial<AppConfig> | null): string | null {
  const candidates = [
    config?.googleOAuth?.clientCredentialsPath,
    process.env.GOOGLE_CREDENTIALS_PATH,
    join(APP_ROOT, "config", "google-oauth-client.json"),
    CREDENTIALS_JSON_PATH,
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function loadCredentials(config?: AppConfig | null): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
} {
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI) {
    return {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      redirectUri: process.env.GOOGLE_REDIRECT_URI,
    };
  }

  const credentialsPath = resolveCredentialsPath(config);
  if (!credentialsPath) {
    throw new Error("Google OAuth credentials JSON is missing.");
  }

  let raw: GoogleCredentialsFile;
  try {
    raw = JSON.parse(readFileSync(credentialsPath, "utf8")) as GoogleCredentialsFile;
  } catch {
    throw new Error("Google OAuth credentials JSON を読み込めません。内容を確認してください。");
  }
  const credentials = raw.installed ?? raw.web;
  if (!credentials) {
    throw new Error("Google OAuth credentials JSON is missing installed/web fields.");
  }

  return {
    clientId: credentials.client_id,
    clientSecret: credentials.client_secret,
    redirectUri: raw.installed ? `${BASE_URL}/auth/google/callback` : credentials.redirect_uris[0] || "",
  };
}

function tokenPathForPurpose(userId: string, purpose: Exclude<GoogleAuthPurpose, "login">, accountId: string): string {
  const safeId = sanitizeAccountId(accountId);
  return purpose === "gmail"
    ? join(userGmailTokensDir(userId), `${safeId}.json`)
    : join(userCalendarTokensDir(userId), `${safeId}.json`);
}

export function createOAuthClient(config?: AppConfig | null) {
  const credentials = loadCredentials(config);
  return new google.auth.OAuth2(credentials.clientId, credentials.clientSecret, credentials.redirectUri);
}

export function loadSavedTokens(tokenPath: string): Record<string, unknown> | null {
  if (!existsSync(tokenPath)) {
    return null;
  }

  return JSON.parse(readFileSync(tokenPath, "utf8")) as Record<string, unknown>;
}

function hasAnyScope(tokens: Record<string, unknown> | null, scopes: string[]): boolean {
  const rawScope = typeof tokens?.scope === "string" ? tokens.scope : "";
  if (!rawScope) {
    return false;
  }
  const granted = new Set(rawScope.split(/\s+/).filter(Boolean));
  return scopes.some((scope) => granted.has(scope));
}

function hasCalendarWriteScope(tokens: Record<string, unknown> | null): boolean {
  return hasAnyScope(tokens, [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.events.owned",
  ]);
}

function saveTokens(tokenPath: string, tokens: Record<string, unknown>): void {
  mkdirSync(dirname(tokenPath), { recursive: true });
  writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
}

export function clearSavedTokens(tokenPath: string): void {
  if (existsSync(tokenPath)) {
    rmSync(tokenPath, { force: true });
  }
}

function getAuthorizedClient(config: AppConfig, tokenPath: string) {
  const client = createOAuthClient(config);
  const tokens = loadSavedTokens(tokenPath);
  if (!tokens) {
    throw new Error("Google OAuth token is missing.");
  }
  client.setCredentials(tokens);
  return client;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function fetchAuthenticatedEmail(client: ReturnType<typeof createOAuthClient>): Promise<string> {
  const oauth2 = google.oauth2({ version: "v2", auth: client });
  const response = await oauth2.userinfo.get();
  return response.data.email ?? "";
}

async function fetchAuthenticatedUserProfile(client: ReturnType<typeof createOAuthClient>): Promise<AuthenticatedUser> {
  const oauth2 = google.oauth2({ version: "v2", auth: client });
  const response = await oauth2.userinfo.get();
  const email = response.data.email ?? "";
  const rawId = response.data.id || email || randomUUID();
  const stableId = sanitizeAccountId(rawId) || createHash("sha256").update(rawId).digest("hex");
  return {
    id: stableId,
    email,
    name: response.data.name ?? email,
    picture: response.data.picture ?? undefined,
  };
}

export async function fetchGoogleAccountEmail(config: AppConfig, account: GoogleAccountConfig | null): Promise<string> {
  if (!account) {
    return "";
  }
  if (account.email) {
    return account.email;
  }

  try {
    const client = getAuthorizedClient(config, account.tokenPath);
    return await fetchAuthenticatedEmail(client);
  } catch {
    return "";
  }
}

export function buildGoogleAuthUrl(config: AppConfig, purpose: GoogleAuthPurpose, state: string): string {
  const client = createOAuthClient(config);
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GOOGLE_SCOPES_BY_PURPOSE[purpose],
    state,
  });
}

export async function exchangeGoogleCode(
  config: AppConfig | null,
  code: string,
  purpose: GoogleAuthPurpose,
  userId?: string,
  requestedAccountId?: string,
): Promise<GoogleAccountConfig | AuthenticatedUser> {
  const client = createOAuthClient(config);
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  if (purpose === "login") {
    return fetchAuthenticatedUserProfile(client);
  }
  const email = await fetchAuthenticatedEmail(client);
  const accountId = buildGoogleAccountId(purpose, email || requestedAccountId || randomUUID());
  if (!userId) {
    throw new Error("userId is required for Google account connections.");
  }
  const tokenPath = tokenPathForPurpose(userId, purpose, accountId);
  saveTokens(tokenPath, tokens as Record<string, unknown>);

  return {
    id: accountId,
    email,
    tokenPath,
  };
}

export function disconnectGoogleAccount(config: AppConfig, purpose: GoogleAuthPurpose, accountId?: string): void {
  const accounts = purpose === "gmail" ? config.googleAccounts.gmails : config.googleAccounts.calendars;
  const account = accountId ? accounts.find((entry) => entry.id === accountId) : accounts[0];
  if (account?.tokenPath) {
    clearSavedTokens(account.tokenPath);
  }
}

export async function listCalendars(config: AppConfig): Promise<Array<{
  id: string;
  summary: string;
  accountId: string;
  accountEmail: string;
  calendarId: string;
  primary: boolean;
  backgroundColor?: string;
  canEdit: boolean;
}>> {
  const calendars: Array<{
    id: string;
    summary: string;
    accountId: string;
    accountEmail: string;
    calendarId: string;
    primary: boolean;
    backgroundColor?: string;
    canEdit: boolean;
  }> = [];

  const lists = await Promise.all(
    config.googleAccounts.calendars.map(async (account) => {
      if (!loadSavedTokens(account.tokenPath)) {
        return [];
      }

      const tokens = loadSavedTokens(account.tokenPath);
      const auth = getAuthorizedClient(config, account.tokenPath);
      const calendar = google.calendar({ version: "v3", auth });
      const response = await calendar.calendarList.list();
      const items = response.data.items ?? [];
      const accountEmail = account.email || items.find((item) => item.primary && item.id)?.id || account.id;

      return items.map((item) => {
        const calendarId = item.id ?? "";
        return {
          id: `${account.id}::${calendarId}`,
          summary: item.summary ?? calendarId,
          accountId: account.id,
          accountEmail,
          calendarId,
          primary: Boolean(item.primary),
          backgroundColor: item.backgroundColor ?? undefined,
          canEdit: (item.accessRole === "owner" || item.accessRole === "writer") && hasCalendarWriteScope(tokens),
        };
      });
    }),
  );
  calendars.push(...lists.flat());

  return calendars;
}

export async function sendGmailMessage(
  config: AppConfig,
  options: {
    to: string;
    subject: string;
    text: string;
    accountId?: string;
  },
): Promise<{ accountEmail: string }> {
  const account = options.accountId
    ? config.googleAccounts.gmails.find((item) => item.id === options.accountId)
    : config.googleAccounts.gmails.find((item) => loadSavedTokens(item.tokenPath));

  if (!account) {
    throw new Error("Gmail account is not connected.");
  }

  const auth = getAuthorizedClient(config, account.tokenPath);
  const gmail = google.gmail({ version: "v1", auth });
  const raw = [
    `To: ${options.to}`,
    `Subject: ${options.subject}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    options.text,
  ].join("\r\n");

  try {
    await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw: base64UrlEncode(raw),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/insufficient|scope|permission/i.test(message)) {
      throw new Error("Gmail の送信権限がありません。Gmail を再接続してください。");
    }
    throw error;
  }

  return {
    accountEmail: account.email || await fetchAuthenticatedEmail(auth),
  };
}

function parseCalendarSelectionKey(value: string): { accountId: string; calendarId: string } | null {
  const [accountId, ...rest] = value.split("::");
  const calendarId = rest.join("::");
  if (!accountId || !calendarId) {
    return null;
  }
  return { accountId, calendarId };
}

export async function listCalendarEvents(
  config: AppConfig,
  options: {
    start: string;
    end: string;
    selectedCalendarIds?: string[];
  },
): Promise<Array<{
  id: string;
  title: string;
  start: string;
  end?: string;
  allDay?: boolean;
  url?: string;
  backgroundColor?: string;
  borderColor?: string;
  extendedProps: {
    calendarId: string;
    accountId: string;
    accountEmail: string;
    description?: string;
      location?: string;
    };
  }>> {
  type SelectedCalendarTarget = {
    id: string;
    summary: string;
    accountId: string;
    accountEmail: string;
    calendarId: string;
    primary: boolean;
    backgroundColor?: string;
    canEdit: boolean;
  };
  const selected = new Set(options.selectedCalendarIds ?? []);
  let targetCalendars: SelectedCalendarTarget[];
  if (selected.size > 0) {
    const availableCalendars = await listCalendars(config);
    targetCalendars = availableCalendars.filter((calendar) => selected.has(calendar.id));
  } else {
    targetCalendars = await listCalendars(config);
  }

  const events: Array<{
    id: string;
    title: string;
    start: string;
    end?: string;
    allDay?: boolean;
    url?: string;
    backgroundColor?: string;
    borderColor?: string;
    extendedProps: {
      calendarId: string;
      accountId: string;
      accountEmail: string;
      canEdit: boolean;
      description?: string;
      location?: string;
    };
  }> = [];

  const results = await Promise.all(
    targetCalendars.map(async (selectedCalendar) => {
      const parsed = parseCalendarSelectionKey(selectedCalendar.id);
      if (!parsed) {
        return [];
      }

      const account = config.googleAccounts.calendars.find((entry) => entry.id === parsed.accountId);
      if (!account || !loadSavedTokens(account.tokenPath)) {
        return [];
      }

      const auth = getAuthorizedClient(config, account.tokenPath);
      const calendar = google.calendar({ version: "v3", auth });
      const response = await calendar.events.list({
        calendarId: parsed.calendarId,
        timeMin: options.start,
        timeMax: options.end,
        singleEvents: true,
        orderBy: "startTime",
        showDeleted: false,
        maxResults: 250,
      });

      return (response.data.items ?? []).flatMap((item) => {
        const start = item.start?.dateTime ?? item.start?.date;
        if (!start) {
          return [];
        }

        const end = item.end?.dateTime ?? item.end?.date ?? undefined;
        const color = selectedCalendar.backgroundColor;
        return [{
          id: `${selectedCalendar.id}::${item.id ?? randomUUID()}`,
          title: item.summary ?? "(No title)",
          start,
          end,
          allDay: Boolean(item.start?.date && !item.start?.dateTime),
          url: item.htmlLink ?? undefined,
          backgroundColor: color,
          borderColor: color,
          extendedProps: {
            calendarId: selectedCalendar.id,
            accountId: selectedCalendar.accountId,
            accountEmail: selectedCalendar.accountEmail,
            canEdit: selectedCalendar.canEdit,
            googleCalendarId: parsed.calendarId,
            googleEventId: item.id ?? "",
            description: item.description ?? undefined,
            location: item.location ?? undefined,
          },
        }];
      });
    }),
  );
  events.push(...results.flat());

  return events;
}

export async function renameCalendarEvent(
  config: AppConfig,
  options: {
    accountId: string;
    calendarId: string;
    eventId: string;
    title: string;
  },
): Promise<void> {
  const account = config.googleAccounts.calendars.find((entry) => entry.id === options.accountId);
  const tokens = account ? loadSavedTokens(account.tokenPath) : null;
  if (!account || !tokens) {
    throw new Error("Calendar account is not connected.");
  }
  if (!hasCalendarWriteScope(tokens)) {
    throw new Error("Google Calendar が読み取り専用で接続されています。カレンダー連携を再接続してください。");
  }

  const auth = getAuthorizedClient(config, account.tokenPath);
  const calendar = google.calendar({ version: "v3", auth });
  const current = await calendar.events.get({
    calendarId: options.calendarId,
    eventId: options.eventId,
  });
  await calendar.events.update({
    calendarId: options.calendarId,
    eventId: options.eventId,
    requestBody: {
      ...current.data,
      summary: options.title,
    },
  });
}

export async function moveCalendarEvent(
  config: AppConfig,
  options: {
    accountId: string;
    calendarId: string;
    eventId: string;
    start: string;
    end?: string;
  },
): Promise<void> {
  const account = config.googleAccounts.calendars.find((entry) => entry.id === options.accountId);
  const tokens = account ? loadSavedTokens(account.tokenPath) : null;
  if (!account || !tokens) {
    throw new Error("Calendar account is not connected.");
  }
  if (!hasCalendarWriteScope(tokens)) {
    throw new Error("Google Calendar が読み取り専用で接続されています。カレンダー連携を再接続してください。");
  }

  const auth = getAuthorizedClient(config, account.tokenPath);
  const calendar = google.calendar({ version: "v3", auth });
  const current = await calendar.events.get({
    calendarId: options.calendarId,
    eventId: options.eventId,
  });
  await calendar.events.update({
    calendarId: options.calendarId,
    eventId: options.eventId,
    requestBody: {
      ...current.data,
      start: {
        dateTime: options.start,
        timeZone: config.timezone,
      },
      end: {
        dateTime: options.end ?? options.start,
        timeZone: config.timezone,
      },
    },
  });
}

export async function createCalendarEvent(
  config: AppConfig,
  options: {
    accountId: string;
    calendarId: string;
    title: string;
    start: string;
    end?: string;
  },
): Promise<{
  googleEventId: string;
  title: string;
  start: string;
  end?: string;
  url?: string;
}> {
  const account = config.googleAccounts.calendars.find((entry) => entry.id === options.accountId);
  const tokens = account ? loadSavedTokens(account.tokenPath) : null;
  if (!account || !tokens) {
    throw new Error("Calendar account is not connected.");
  }
  if (!hasCalendarWriteScope(tokens)) {
    throw new Error("Google Calendar が読み取り専用で接続されています。カレンダー連携を再接続してください。");
  }

  const auth = getAuthorizedClient(config, account.tokenPath);
  const calendar = google.calendar({ version: "v3", auth });
  const response = await calendar.events.insert({
    calendarId: options.calendarId,
    requestBody: {
      summary: options.title,
      start: {
        dateTime: options.start,
        timeZone: config.timezone,
      },
      end: {
        dateTime: options.end ?? options.start,
        timeZone: config.timezone,
      },
    },
  });
  return {
    googleEventId: response.data.id ?? "",
    title: response.data.summary ?? options.title,
    start: response.data.start?.dateTime ?? options.start,
    end: response.data.end?.dateTime ?? options.end ?? options.start,
    url: response.data.htmlLink ?? undefined,
  };
}

export async function createRecurringCalendarEvent(
  config: AppConfig,
  options: {
    accountId: string;
    calendarId: string;
    title: string;
    start: string;
    end: string;
    recurrenceRule: string;
  },
): Promise<void> {
  const account = config.googleAccounts.calendars.find((entry) => entry.id === options.accountId);
  const tokens = account ? loadSavedTokens(account.tokenPath) : null;
  if (!account || !tokens) {
    throw new Error("Calendar account is not connected.");
  }
  if (!hasCalendarWriteScope(tokens)) {
    throw new Error("Google Calendar が読み取り専用で接続されています。カレンダー連携を再接続してください。");
  }

  const auth = getAuthorizedClient(config, account.tokenPath);
  const calendar = google.calendar({ version: "v3", auth });
  await calendar.events.insert({
    calendarId: options.calendarId,
    requestBody: {
      summary: options.title,
      start: {
        dateTime: options.start,
        timeZone: config.timezone,
      },
      end: {
        dateTime: options.end,
        timeZone: config.timezone,
      },
      recurrence: [`RRULE:${options.recurrenceRule}`],
    },
  });
}

export async function deleteCalendarEvent(
  config: AppConfig,
  options: {
    accountId: string;
    calendarId: string;
    eventId: string;
  },
): Promise<void> {
  const account = config.googleAccounts.calendars.find((entry) => entry.id === options.accountId);
  const tokens = account ? loadSavedTokens(account.tokenPath) : null;
  if (!account || !tokens) {
    throw new Error("Calendar account is not connected.");
  }
  if (!hasCalendarWriteScope(tokens)) {
    throw new Error("Google Calendar が読み取り専用で接続されています。カレンダー連携を再接続してください。");
  }

  const auth = getAuthorizedClient(config, account.tokenPath);
  const calendar = google.calendar({ version: "v3", auth });
  await calendar.events.delete({
    calendarId: options.calendarId,
    eventId: options.eventId,
  });
}
