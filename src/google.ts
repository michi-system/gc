import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { google, type calendar_v3, type gmail_v1, type sheets_v4 } from "googleapis";

import { DEFAULT_TOKEN_PATH } from "./constants.js";
import { parseGmailSubmission, type GmailLikeMessage } from "./gmailParser.js";
import type { AppConfig, CalendarChoice, CalendarSession, GmailSubmission, RosterEntry } from "./types.js";
import { inferDateFromIso, normalizeText } from "./utils.js";

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
];

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

function loadCredentials(config: AppConfig): {
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

  if (!existsSync(config.googleOAuth.clientCredentialsPath)) {
    throw new Error(
      `Google OAuth credentials not found at ${config.googleOAuth.clientCredentialsPath}. Set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REDIRECT_URI or place the JSON file there.`,
    );
  }

  const raw = JSON.parse(readFileSync(config.googleOAuth.clientCredentialsPath, "utf8")) as GoogleCredentialsFile;
  const credentials = raw.installed ?? raw.web;
  if (!credentials) {
    throw new Error("Google OAuth credentials JSON is missing installed/web fields.");
  }

  return {
    clientId: credentials.client_id,
    clientSecret: credentials.client_secret,
    redirectUri: credentials.redirect_uris[0],
  };
}

export function createOAuthClient(config: AppConfig) {
  const credentials = loadCredentials(config);
  return new google.auth.OAuth2(credentials.clientId, credentials.clientSecret, credentials.redirectUri);
}

export function loadSavedTokens(config: AppConfig): Record<string, unknown> | null {
  const tokenPath = process.env.GOOGLE_TOKEN_PATH ?? DEFAULT_TOKEN_PATH;
  if (!existsSync(tokenPath)) {
    return null;
  }
  return JSON.parse(readFileSync(tokenPath, "utf8")) as Record<string, unknown>;
}

export function saveTokens(tokens: Record<string, unknown>): void {
  const tokenPath = process.env.GOOGLE_TOKEN_PATH ?? DEFAULT_TOKEN_PATH;
  mkdirSync(dirname(tokenPath), { recursive: true });
  writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
}

export function getAuthorizedClient(config: AppConfig) {
  const client = createOAuthClient(config);
  const tokens = loadSavedTokens(config);
  if (!tokens) {
    throw new Error("Google OAuth token is missing. Connect Google from the Setup tab first.");
  }
  client.setCredentials(tokens);
  return client;
}

export function buildGoogleAuthUrl(config: AppConfig): string {
  const client = createOAuthClient(config);
  return client.generateAuthUrl({
    access_type: "offline",
    scope: GOOGLE_SCOPES,
    prompt: "consent",
  });
}

export async function exchangeGoogleCode(config: AppConfig, code: string): Promise<void> {
  const client = createOAuthClient(config);
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  saveTokens(tokens as Record<string, unknown>);
}

export async function listCalendars(config: AppConfig): Promise<CalendarChoice[]> {
  const auth = getAuthorizedClient(config);
  const calendar = google.calendar({ version: "v3", auth });
  const response = await calendar.calendarList.list();
  return (response.data.items ?? []).map((item) => ({
    id: item.id ?? "",
    summary: item.summary ?? item.id ?? "",
    primary: Boolean(item.primary),
  }));
}

function messageHeader(message: gmail_v1.Schema$Message, name: string): string {
  const headers = message.payload?.headers ?? [];
  const header = headers.find((item) => normalizeText(item.name) === name);
  return header?.value ?? "";
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function extractBodyFromPart(part: gmail_v1.Schema$MessagePart | undefined): string {
  if (!part) {
    return "";
  }

  if (part.mimeType === "text/plain" && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }

  for (const child of part.parts ?? []) {
    const text = extractBodyFromPart(child);
    if (text) {
      return text;
    }
  }

  if (part.body?.data) {
    return decodeBase64Url(part.body.data);
  }

  return "";
}

function columnToIndex(columnName: string): number {
  let result = 0;
  for (const char of columnName.toUpperCase()) {
    result = result * 26 + (char.charCodeAt(0) - 64);
  }
  return result - 1;
}

function matchRosterEntry(haystack: string, roster: RosterEntry[]): RosterEntry | null {
  const candidates: Array<{ entry: RosterEntry; score: number }> = [];

  roster.forEach((entry) => {
    const patterns = [entry.studentName, ...entry.aliases, entry.calendarMatchPattern].filter(Boolean);
    const matchedPattern = patterns
      .map((pattern) => normalizeText(pattern))
      .filter((pattern) => pattern && haystack.includes(pattern))
      .sort((left, right) => right.length - left.length)[0];

    if (matchedPattern) {
      candidates.push({ entry, score: matchedPattern.length });
    }
  });

  candidates.sort((left, right) => right.score - left.score);
  if (candidates.length === 0) {
    return null;
  }
  if (candidates.length === 1) {
    return candidates[0].entry;
  }
  return candidates[0].score > candidates[1].score ? candidates[0].entry : null;
}

function inferTaskType(text: string, rosterEntry: RosterEntry | null): CalendarSession["taskType"] {
  if (text.includes("ティーチング")) {
    return "teaching";
  }

  if (text.includes("コーチング")) {
    return "coaching";
  }

  if (rosterEntry?.defaultTaskType) {
    return rosterEntry.defaultTaskType;
  }

  return "other";
}

function buildCalendarSession(
  event: calendar_v3.Schema$Event,
  calendarId: string,
  roster: RosterEntry[],
  timezone: string,
): CalendarSession | null {
  if (!event.id || !event.start?.dateTime || !event.end?.dateTime || event.status === "cancelled") {
    return null;
  }

  const rawTitle = event.summary ?? "";
  const rawDescription = event.description ?? "";
  const haystack = normalizeText(`${rawTitle} ${rawDescription}`);
  const rosterEntry = matchRosterEntry(haystack, roster);
  const taskType = inferTaskType(haystack, rosterEntry);

  return {
    id: event.id,
    recurringEventId: event.recurringEventId ?? null,
    originalStartAt: event.originalStartTime?.dateTime ?? null,
    startAt: event.start.dateTime,
    endAt: event.end.dateTime,
    sessionDate: inferDateFromIso(event.start.dateTime, timezone),
    studentName: rosterEntry?.studentName,
    studentCode: rosterEntry?.studentCode,
    taskType,
    rawTitle,
    rawDescription,
    calendarId,
    sourceJson: event as Record<string, unknown>,
  };
}

export async function fetchCalendarSessions(config: AppConfig, roster: RosterEntry[]): Promise<CalendarSession[]> {
  const auth = getAuthorizedClient(config);
  const calendar = google.calendar({ version: "v3", auth });
  const now = new Date();
  const timeMin = new Date(now.getTime() - config.syncWindowDays * 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(now.getTime() + config.syncWindowDays * 24 * 60 * 60 * 1000).toISOString();
  const sessions: CalendarSession[] = [];

  for (const calendarId of config.calendars.selectedCalendarIds) {
    const response = await calendar.events.list({
      calendarId,
      singleEvents: true,
      showDeleted: false,
      orderBy: "startTime",
      timeMin,
      timeMax,
      maxResults: 1000,
    });

    for (const event of response.data.items ?? []) {
      const session = buildCalendarSession(event, calendarId, roster, config.timezone);
      if (session) {
        sessions.push(session);
      }
    }
  }

  return sessions.sort((left, right) => left.startAt.localeCompare(right.startAt));
}

export async function fetchGmailSubmissions(config: AppConfig): Promise<GmailSubmission[]> {
  const auth = getAuthorizedClient(config);
  const gmail = google.gmail({ version: "v1", auth });
  const submissions: GmailSubmission[] = [];
  const seenIds = new Set<string>();

  for (const query of Object.values(config.gmail.queries)) {
    const listResponse = await gmail.users.messages.list({
      userId: "me",
      maxResults: 100,
      q: query,
    });

    for (const item of listResponse.data.messages ?? []) {
      if (!item.id || seenIds.has(item.id)) {
        continue;
      }

      const messageResponse = await gmail.users.messages.get({
        userId: "me",
        id: item.id,
        format: "full",
      });

      const message = messageResponse.data;
      const body = extractBodyFromPart(message.payload);
      const parsed = parseGmailSubmission({
        id: item.id,
        subject: messageHeader(message, "Subject"),
        internalDate: message.internalDate ?? String(Date.now()),
        body,
      } satisfies GmailLikeMessage);

      if (parsed) {
        submissions.push(parsed);
        seenIds.add(parsed.messageId);
      }
    }
  }

  return submissions.sort((left, right) => left.submittedAt.localeCompare(right.submittedAt));
}

export async function fetchSheetRoster(config: AppConfig, existingRoster: RosterEntry[]): Promise<RosterEntry[]> {
  if (!config.sheets.sheetName) {
    return existingRoster;
  }

  const auth = getAuthorizedClient(config);
  const sheets = google.sheets({ version: "v4", auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheets.spreadsheetId,
    range: `${config.sheets.sheetName}!A:ZZ`,
  });

  const rows = response.data.values ?? [];
  if (rows.length < config.sheets.headerRow) {
    return existingRoster;
  }

  const nameIndex = columnToIndex(config.sheets.studentNameColumn);
  const codeIndex = columnToIndex(config.sheets.studentCodeColumn);
  const existingByCode = new Map(existingRoster.map((entry) => [entry.studentCode, entry]));
  const now = new Date().toISOString();
  const nextEntries: RosterEntry[] = [];

  rows.slice(config.sheets.headerRow).forEach((row) => {
    const studentName = normalizeText(row[nameIndex]);
    const studentCode = normalizeText(row[codeIndex]);

    if (!studentName || !studentCode) {
      return;
    }

    const previous = existingByCode.get(studentCode);
    nextEntries.push({
      studentName,
      studentCode,
      aliases: previous?.aliases ?? [],
      calendarMatchPattern: previous?.calendarMatchPattern ?? "",
      handoffPolicy: previous?.handoffPolicy ?? "none",
      defaultTaskType: previous?.defaultTaskType ?? "coaching",
      manualOnly: false,
      updatedAt: now,
    });
  });

  existingRoster
    .filter((entry) => entry.manualOnly)
    .forEach((entry) => {
      nextEntries.push(entry);
    });

  return nextEntries.sort((left, right) => left.studentName.localeCompare(right.studentName, "ja"));
}
