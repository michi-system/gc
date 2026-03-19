import express, { type Response } from "express";
import { dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

import { APP_PORT, BASE_URL, CONFIG_PATH, CREDENTIALS_JSON_PATH, PUBLIC_DIR, userStaleNotificationsPath } from "./env.js";
import { runAutofillTask } from "./autofill-runner.js";
import {
  FORM_CATALOG,
  FORM_IDS,
  FORM_URLS,
  handoffFieldSpecs,
  handoffTextareaTitle,
  requiredMissingFields,
  type GreenfieldFormType,
  type HandoffPolicy,
} from "./forms.js";
import { listGmailSubmissions } from "./gmail.js";
import {
  buildGoogleAuthUrl,
  clearSavedTokens,
  createCalendarEvent,
  createRecurringCalendarEvent,
  deleteCalendarEvent,
  disconnectGoogleAccount,
  exchangeGoogleCode,
  fetchGoogleAccountEmail,
  listCalendarEvents,
  listCalendars,
  loadSavedTokens,
  moveCalendarEvent,
  renameCalendarEvent,
} from "./google.js";
import {
  DEFAULT_CONFIG,
  ensureStorage,
  loadConfig,
  loadRuntimeState,
  mergeConfig,
  saveAutofillTask,
  saveConfig,
  saveReconciliationOverride,
  saveStudentCodeDirectoryEntry,
  saveStudentRoutineProfile,
  setSubmissionInvalidated,
  upsertAccount,
} from "./store.js";
import type {
  AppConfig,
  ApplicationFormItem,
  AnswerValue,
  AuthenticatedUser,
  AutofillBundleItem,
  AutofillTaskRecord,
  CalendarActionSuggestion,
  GmailSubmissionRecord,
  GoogleAccountConfig,
  GoogleAccountStatus,
  GoogleAuthPurpose,
  OAuthRequestState,
  ReconciliationKind,
  ReconciliationOverrideRecord,
  ReconciliationRecord,
  RuleEvidence,
  SourceSnapshot,
  StudentCodeDirectoryEntry,
  StudentRoutineProfile,
  TaskPayload,
  WorkflowAutofillSuggestion,
} from "./types.js";

const app = express();
const oauthRequests = new Map<string, OAuthRequestState>();
const summaryCache = new Map<string, { expiresAt: number; payload: unknown }>();
const gmailSubmissionsCache = new Map<string, { expiresAt: number; payload: GmailSubmissionRecord[] }>();
const calendarListCache = new Map<string, { expiresAt: number; payload: Awaited<ReturnType<typeof listCalendars>> }>();
const SUMMARY_CACHE_TTL_MS = 15_000;
const GMAIL_CACHE_TTL_MS = 15_000;
const CALENDAR_LIST_CACHE_TTL_MS = 300_000;
const SESSION_COOKIE_NAME = "gc_greenfield_session";
const SESSION_SECRET = process.env.GC_GREENFIELD_SESSION_SECRET ?? "gc-greenfield-dev-session-secret";
const LOCAL_OWNER_USER_ID = "__local_owner__";
const LOCAL_DEV_HOSTS = new Set(["127.0.0.1", "localhost"]);

type RequestWithAuth = express.Request & { authUser?: AuthenticatedUser };

ensureStorage();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR, {
  etag: false,
  lastModified: false,
  setHeaders(response) {
    response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    response.setHeader("Pragma", "no-cache");
    response.setHeader("Expires", "0");
  },
}));

app.use((request, response, next) => {
  const user = readAuthenticatedUser(request);
  if (user) {
    (request as RequestWithAuth).authUser = user;
  }
  const publicApiPaths = new Set([
    "/api/health",
    "/api/me",
    "/api/auth/google/start",
    "/api/auth/logout",
  ]);
  if (!request.path.startsWith("/api") || publicApiPaths.has(request.path)) {
    next();
    return;
  }
  if (!user) {
    respondError(response, new Error("Authentication required"), 401);
    return;
  }
  next();
});

function respondError(response: Response, error: unknown, status = 500) {
  response.status(status).json({
    error: error instanceof Error ? error.message : "Unknown error",
  });
}

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /rate limit|rate-limit|user-rate limit exceeded|retry after/i.test(message);
}

function formatRecurrenceUntil(iso: string): string {
  const date = new Date(iso);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}T145959Z`;
}

function nextOccurrenceIso(weekday: number, time: string): { start: string; end: string } {
  const [hoursRaw, minutesRaw] = time.split(":");
  const hours = Number(hoursRaw);
  const minutes = Number(minutesRaw);
  const now = new Date();
  const base = new Date(now);
  base.setSeconds(0, 0);
  base.setHours(hours, minutes, 0, 0);
  const currentWeekday = base.getDay();
  let delta = (weekday - currentWeekday + 7) % 7;
  if (delta === 0 && base.getTime() <= now.getTime()) {
    delta = 7;
  }
  base.setDate(base.getDate() + delta);
  const end = new Date(base.getTime() + 60 * 60 * 1000);
  return {
    start: base.toISOString(),
    end: end.toISOString(),
  };
}

function clearSummaryCache(): void {
  summaryCache.clear();
  gmailSubmissionsCache.clear();
  calendarListCache.clear();
}

function signSessionPayload(payload: string): string {
  return createHash("sha256")
    .update(`${payload}.${SESSION_SECRET}`)
    .digest("hex");
}

function serializeSessionCookie(user: AuthenticatedUser): string {
  const payload = Buffer.from(JSON.stringify(user), "utf8").toString("base64url");
  const signature = signSessionPayload(payload);
  return `${payload}.${signature}`;
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) {
    return {};
  }
  return Object.fromEntries(
    header.split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        if (index === -1) {
          return [part, ""];
        }
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

function readSessionUser(request: express.Request): AuthenticatedUser | null {
  const raw = parseCookies(request.headers.cookie)[SESSION_COOKIE_NAME];
  if (!raw) {
    return null;
  }
  const [payload, signature] = raw.split(".");
  if (!payload || !signature || signSessionPayload(payload) !== signature) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<AuthenticatedUser>;
    if (!parsed?.id || !parsed?.email || !parsed?.name) {
      return null;
    }
    return {
      id: parsed.id,
      email: parsed.email,
      name: parsed.name,
      picture: parsed.picture,
    };
  } catch {
    return null;
  }
}

function readLegacyLocalOwnerUser(): AuthenticatedUser | null {
  if (!existsSync(CONFIG_PATH)) {
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<AppConfig>;
    const coachName = raw.coachProfile?.name?.trim();
    const coachEmail = raw.coachProfile?.email?.trim();
    const connectedGmail = raw.googleAccounts?.gmails?.[0]?.email?.trim();
    const connectedCalendar = raw.googleAccounts?.calendars?.[0]?.email?.trim();
    const email = coachEmail || connectedGmail || connectedCalendar;
    if (!email) {
      return null;
    }
    return {
      id: LOCAL_OWNER_USER_ID,
      email,
      name: coachName || "Local Owner",
    };
  } catch {
    return null;
  }
}

function readAuthenticatedUser(request: express.Request): AuthenticatedUser | null {
  const sessionUser = readSessionUser(request);
  if (sessionUser) {
    return sessionUser;
  }
  if (!LOCAL_DEV_HOSTS.has(request.hostname)) {
    return null;
  }
  return readLegacyLocalOwnerUser();
}

function setSessionCookie(response: Response, user: AuthenticatedUser): void {
  response.setHeader("Set-Cookie", `${SESSION_COOKIE_NAME}=${encodeURIComponent(serializeSessionCookie(user))}; Path=/; HttpOnly; SameSite=Lax`);
}

function clearSessionCookie(response: Response): void {
  response.setHeader("Set-Cookie", `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function getRequestUser(request: express.Request): AuthenticatedUser | null {
  return (request as RequestWithAuth).authUser ?? null;
}

function loadStaleNotificationHistory(userId: string): Record<string, { sentAt: string; recipient: string }> {
  const path = userStaleNotificationsPath(userId);
  if (!existsSync(path)) {
    return {};
  }

  return JSON.parse(readFileSync(path, "utf8")) as Record<string, { sentAt: string; recipient: string }>;
}

function saveStaleNotificationHistory(userId: string, history: Record<string, { sentAt: string; recipient: string }>): void {
  writeFileSync(userStaleNotificationsPath(userId), JSON.stringify(history, null, 2));
}

async function getWorkspaceSummaryPayload(
  userId: string,
  config: AppConfig,
  options: { start: string; end: string; calendarIds: string[] },
) {
  const cacheKey = JSON.stringify({
    userId,
    start: options.start,
    end: options.end,
    calendarIds: options.calendarIds,
    gmailAccounts: config.googleAccounts.gmails.map((account) => account.id),
    calendarAccounts: config.googleAccounts.calendars.map((account) => account.id),
  });
  const cached = summaryCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.payload as {
      events: Awaited<ReturnType<typeof listCalendarEvents>>;
      submissions: GmailSubmissionRecord[];
      students: unknown[];
      applications: Array<Record<string, unknown>>;
      coachProfile: AppConfig["coachProfile"];
    };
  }
  try {
    const [events, submissions] = await Promise.all([
      listCalendarEvents(config, {
        start: options.start,
        end: options.end,
        selectedCalendarIds: options.calendarIds,
      }),
      getCachedGmailSubmissions(userId, config, {
        start: options.start,
        end: options.end,
      }),
    ]);
    const runtimeState = loadRuntimeState(userId);

    const payload = {
      events,
      submissions,
      ...buildWorkspaceSummary(events, submissions, runtimeState, config),
      coachProfile: config.coachProfile,
    };
    summaryCache.set(cacheKey, {
      expiresAt: Date.now() + SUMMARY_CACHE_TTL_MS,
      payload,
    });
    return payload;
  } catch (error) {
    if (cached && isRateLimitError(error)) {
      return cached.payload as {
        events: Awaited<ReturnType<typeof listCalendarEvents>>;
        submissions: GmailSubmissionRecord[];
        students: unknown[];
        applications: Array<Record<string, unknown>>;
        coachProfile: AppConfig["coachProfile"];
      };
    }
    throw error;
  }
}

async function getCachedCalendars(config: AppConfig) {
  const cacheKey = JSON.stringify({
    userConfig: config.coachProfile.email,
    calendarAccounts: config.googleAccounts.calendars.map((account) => account.id),
  });
  const cached = calendarListCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.payload;
  }

  const payload = await listCalendars(config);
  calendarListCache.set(cacheKey, {
    expiresAt: Date.now() + CALENDAR_LIST_CACHE_TTL_MS,
    payload,
  });
  return payload;
}

async function getCachedGmailSubmissions(
  userId: string,
  config: AppConfig,
  range: { start?: string; end?: string },
) {
  const cacheKey = JSON.stringify({
    userId,
    start: range.start ?? "",
    end: range.end ?? "",
    coachProfile: config.coachProfile,
    gmailAccounts: config.googleAccounts.gmails.map((account) => account.id),
  });
  const cached = gmailSubmissionsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.payload;
  }
  try {
    const payload = await listGmailSubmissions(config, range);
    gmailSubmissionsCache.set(cacheKey, {
      expiresAt: Date.now() + GMAIL_CACHE_TTL_MS,
      payload,
    });
    return payload;
  } catch (error) {
    if (cached && isRateLimitError(error)) {
      return cached.payload;
    }
    throw error;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeText(value: string | undefined): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inferDateFromIso(value: string | undefined): string {
  if (!value) {
    return "";
  }
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

function inferTimeFromIso(value: string | undefined): string {
  if (!value) {
    return "";
  }
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function formatFullNameForForm(value: string | undefined): string {
  const normalized = normalizeText(value);
  if (!normalized) return "";
  if (/\s/u.test(normalized)) {
    return normalized.replace(/\s+/gu, " ");
  }
  const compact = normalized.replace(/\s+/gu, "");
  if (!/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+$/u.test(compact)) {
    return normalized;
  }
  if (compact.length === 4) {
    return `${compact.slice(0, 2)} ${compact.slice(2)}`;
  }
  if (compact.length === 5) {
    return `${compact.slice(0, 2)} ${compact.slice(2)}`;
  }
  if (compact.length === 6) {
    return `${compact.slice(0, 3)} ${compact.slice(3)}`;
  }
  return normalized;
}

function durationToHoursMinutes(start: string | undefined, end: string | undefined): string {
  if (!start || !end) {
    return "0:30";
  }
  const diffMinutes = Math.max(30, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000));
  const hours = Math.floor(diffMinutes / 60);
  const minutes = diffMinutes % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}`;
}

function addMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

function formatIsoWithOffset(date: string, time: string): string {
  return `${date}T${time}:00+09:00`;
}

function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00+09:00`).getDay();
}

function formatScheduleChangeDateLabel(
  date: string | undefined,
  time: string | undefined,
  options: { includeYear: boolean },
): string {
  if (!date) {
    return options.includeYear ? "通常日時不明" : "変更後日時不明";
  }
  const weekday = ["日", "月", "火", "水", "木", "金", "土"][weekdayOf(date)] ?? "";
  const [, month = "", day = ""] = date.split("-");
  const monthNumber = String(Number(month));
  const dayNumber = String(Number(day));
  const timePart = time ? ` ${time}` : "";
  if (options.includeYear) {
    const [year = ""] = date.split("-");
    return `${year}年${monthNumber}月${dayNumber}日(${weekday})${timePart}`;
  }
  return `${monthNumber}月${dayNumber}日(${weekday})${timePart}`;
}

function coachingDateLabel(value: string | undefined): string {
  const date = inferDateFromIso(value);
  const time = inferTimeFromIso(value);
  return formatScheduleChangeDateLabel(date, time, { includeYear: true });
}

function effectiveHandoffPolicy(
  record: ReconciliationRecord,
  workflowSuggestion: WorkflowAutofillSuggestion | undefined,
): HandoffPolicy | undefined {
  const profileCourse = record.studentRoutineProfile?.course;
  return record.submission?.handoff?.policy
    ?? workflowSuggestion?.handoffPolicy
    ?? (profileCourse === "advance" || profileCourse === "premium" ? "advance_premium" : undefined);
}

function defaultStudyHours(
  _course: StudentRoutineProfile["course"] | undefined,
  _teachingType: StudentRoutineProfile["teachingType"] | undefined,
): number {
  return 3;
}

function defaultHomeworkHoursPerDay(
  _course: StudentRoutineProfile["course"] | undefined,
  _teachingType: StudentRoutineProfile["teachingType"] | undefined,
): number {
  return 1.5;
}

function buildAdvancePremiumHandoffContent(
  record: ReconciliationRecord,
  coachName: string,
): string {
  const course = record.studentRoutineProfile?.course;
  const teachingType = record.studentRoutineProfile?.teachingType;
  const studyHours = defaultStudyHours(course, teachingType);
  const homeworkHours = defaultHomeworkHoursPerDay(course, teachingType);
  return [
    `記入者：${coachName}`,
    `コーチング日：${coachingDateLabel(record.start)}`,
    `生徒さんの勉強可能時間：${studyHours}時間`,
    `自分が担当している科目の宿題にかかる予想時間：${homeworkHours}時間/日`,
    "方針/共有事項/相談事項：",
    "通常通り実施しました。よろしくお願いいたします。",
  ].join("\n");
}

function timePartOf(value: string | undefined): string {
  const time = inferTimeFromIso(value);
  return time || "20:00";
}

function dedupeAutofillReason(missingFields: string[], reviewHints: string[]): string {
  const normalizedHints = reviewHints.map((hint) => hint.trim()).filter(Boolean);
  const compactMissing = missingFields.filter((field) =>
    !normalizedHints.some((hint) => hint.includes(field)),
  );
  return [...compactMissing, ...normalizedHints].join(" / ");
}

function reasonForAutofillTaskStatus(
  task: AutofillTaskRecord | null | undefined,
  fallbackReason: string,
): string {
  if (!task) {
    return fallbackReason;
  }
  if (task.lastError) {
    return task.lastError;
  }
  if (
    task.status === "autofill_ready"
    || task.status === "autofill_running"
    || task.status === "awaiting_user_submit"
    || task.status === "submitted_confirmed"
  ) {
    return "";
  }
  if (task.status === "autofill_blocked") {
    const reviewHints = task.payload.reviewHints ?? [];
    return dedupeAutofillReason(task.missingFields ?? [], reviewHints) || fallbackReason;
  }
  return fallbackReason;
}

function normalizeWorkflowDisplayStatus(
  status: AutofillTaskRecord["status"] | "not_applicable" | undefined,
): AutofillTaskRecord["status"] | "not_applicable" | undefined {
  if (status === "autofill_running" || status === "submitted_confirmed") {
    return "awaiting_user_submit";
  }
  return status;
}

function inferStudentCodeDirectory(
  submissions: GmailSubmissionRecord[],
  runtimeState: ReturnType<typeof loadRuntimeState>,
): Record<string, StudentCodeDirectoryEntry> {
  const next = { ...runtimeState.studentCodeDirectory };
  const evidenceByStudent = new Map<string, { studentName: string; counts: Map<string, number> }>();

  for (const submission of submissions) {
    const studentCode = submission.studentCode ?? submission.workReport?.studentCode ?? submission.handoff?.studentCode;
    if (!studentCode) {
      continue;
    }
    for (const name of candidateStudentNames(submission)) {
      const studentKey = normalizeName(name);
      if (!studentKey || studentKey === "未特定") {
        continue;
      }
      const bucket = evidenceByStudent.get(studentKey) ?? {
        studentName: displayStudentName(name),
        counts: new Map<string, number>(),
      };
      bucket.counts.set(studentCode, (bucket.counts.get(studentCode) ?? 0) + 1);
      evidenceByStudent.set(studentKey, bucket);
    }
  }

  for (const [studentKey, bucket] of evidenceByStudent.entries()) {
    const ranked = Array.from(bucket.counts.entries()).sort((left, right) => right[1] - left[1]);
    const [topCode, topCount] = ranked[0] ?? [];
    const secondCount = ranked[1]?.[1] ?? 0;
    if (!topCode || topCount < 3 || topCount === secondCount) {
      continue;
    }
    const current = next[studentKey];
    if (!current || current.source !== "manual") {
      next[studentKey] = {
        studentKey,
        studentName: bucket.studentName,
        studentCode: topCode,
        source: "inferred",
        confidence: Math.min(0.99, 0.55 + topCount * 0.1),
        evidenceCount: topCount,
        updatedAt: nowIso(),
      };
    }
  }

  return next;
}

function resolveStudentCodeDirectoryEntry(
  directory: Record<string, StudentCodeDirectoryEntry>,
  studentKey: string,
  studentName: string,
): StudentCodeDirectoryEntry | undefined {
  if (directory[studentKey]) {
    return directory[studentKey];
  }
  return Object.values(directory).find((entry) =>
    isLikelySameStudent(entry.studentName, studentName),
  );
}

function resolveStudentRoutineProfileEntry(
  directory: Record<string, StudentRoutineProfile>,
  studentKey: string,
  studentName: string,
): StudentRoutineProfile | undefined {
  if (directory[studentKey]) {
    return directory[studentKey];
  }
  return Object.values(directory).find((entry) =>
    isLikelySameStudent(entry.studentName, studentName),
  );
}

function normalizeRoutineExpectedKinds(value: Partial<StudentRoutineProfile["expectedKinds"]> | undefined) {
  return {
    main: value?.main !== false,
    extra_thirty: Boolean(value?.extra_thirty),
    handoff: Boolean(value?.handoff),
    handoff_five: Boolean(value?.handoff_five),
  };
}

function normalizeRoutineCourse(value: unknown): StudentRoutineProfile["course"] {
  if (value === "standard" || value === "advance" || value === "premium" || value === "chat_support" || value === "unknown") {
    return value;
  }
  return "unknown";
}

function normalizeRoutineTeachingType(value: unknown): StudentRoutineProfile["teachingType"] {
  if (value === "coaching_only" || value === "essay_teaching" || value === "past_exam_teaching" || value === "subject_teaching" || value === "unknown") {
    return value;
  }
  return "unknown";
}

function deriveExpectedKindsFromRoutine(
  course: StudentRoutineProfile["course"],
  teachingType: StudentRoutineProfile["teachingType"],
  fallback?: Partial<StudentRoutineProfile["expectedKinds"]>,
) {
  const base = normalizeRoutineExpectedKinds(fallback);
  const advancePremium = course === "advance" || course === "premium";
  return {
    main: base.main !== false,
    handoff: base.handoff || advancePremium,
    handoff_five: base.handoff_five || advancePremium,
    extra_thirty: base.extra_thirty || (advancePremium && (teachingType === "essay_teaching" || teachingType === "past_exam_teaching")),
  };
}

function inferStudentRoutineProfile(
  studentKey: string,
  studentName: string,
  sessions: ReconciliationRecord[],
  manualProfile?: StudentRoutineProfile,
): StudentRoutineProfile {
  const calendarSessions = sessions
    .filter((item) => item.source === "calendar")
    .sort((left, right) => left.start.localeCompare(right.start));

  const buckets = new Map<string, { count: number; weekday: number; time: string; durationMinutesTotal: number }>();
  for (const session of calendarSessions) {
    const weekday = weekdayOf(session.start.slice(0, 10));
    const time = timePartOf(session.start);
    const durationMinutes = Math.max(
      30,
      Math.round((new Date(session.end ?? addMinutes(session.start, 60)).getTime() - new Date(session.start).getTime()) / 60000),
    );
    const key = `${weekday}|${time}`;
    const current = buckets.get(key) ?? { count: 0, weekday, time, durationMinutesTotal: 0 };
    current.count += 1;
    current.durationMinutesTotal += durationMinutes;
    buckets.set(key, current);
  }
  const dominant = Array.from(buckets.values()).sort((left, right) => right.count - left.count)[0];

  const extraEvidence = sessions.filter((item) =>
    item.kind === "extra_thirty"
    || (item.workflowSuggestions ?? []).some((suggestion) => suggestion.kind === "extra_thirty")
    || item.title.includes("小論文")
    || item.title.includes("ティーチング"),
  ).length;
  const handoffEvidence = sessions.filter((item) =>
    !isLegacyHandoffYear(item.start)
    && (
      item.kind === "handoff"
      || item.kind === "handoff_five"
      || (item.workflowSuggestions ?? []).some((suggestion) => suggestion.kind === "handoff")
      || (item.workflowSuggestions ?? []).some((suggestion) => suggestion.kind === "handoff_five")
      || item.title.includes("振替")
      || item.title.includes("引き継ぎ")
    ),
  ).length;

  const essayEvidence = sessions.filter((item) =>
    /小論文/u.test(item.title)
    || /小論文/u.test(item.attentionReason || "")
    || (item.workflowSuggestions ?? []).some((suggestion) => /小論文/u.test(suggestion.reason) || /小論文/u.test(suggestion.preview || "")),
  ).length;
  const pastExamEvidence = sessions.filter((item) =>
    /過去問/u.test(item.title)
    || /過去問/u.test(item.attentionReason || "")
    || (item.workflowSuggestions ?? []).some((suggestion) => /過去問/u.test(suggestion.reason) || /過去問/u.test(suggestion.preview || "")),
  ).length;
  const genericTeachingEvidence = sessions.filter((item) =>
    /ティーチング/u.test(item.title)
    || /ティーチング/u.test(item.attentionReason || ""),
  ).length;

  const inferredCourse: StudentRoutineProfile["course"] = handoffEvidence >= 2
    ? ((calendarSessions.length >= 10 || dominant?.count >= 10) ? "premium" : "advance")
    : "standard";
  const inferredTeachingType: StudentRoutineProfile["teachingType"] = essayEvidence >= 1
    ? "essay_teaching"
    : pastExamEvidence >= 1
      ? "past_exam_teaching"
      : genericTeachingEvidence >= 1
        ? "subject_teaching"
        : "coaching_only";
  const inferredExpectedKinds = deriveExpectedKindsFromRoutine(inferredCourse, inferredTeachingType, {
    main: true,
    extra_thirty: extraEvidence >= 2,
    handoff: handoffEvidence >= 2,
    handoff_five: handoffEvidence >= 2,
  });

  const inferred: StudentRoutineProfile = {
    studentKey,
    studentName,
    course: inferredCourse,
    teachingType: inferredTeachingType,
    weekday: dominant?.weekday ?? null,
    time: dominant?.time ?? "",
    durationMinutes: dominant ? Math.max(30, Math.round(dominant.durationMinutesTotal / dominant.count)) : null,
    expectedKinds: inferredExpectedKinds,
    note: "",
    source: "inferred",
    confidence: dominant ? Math.min(0.99, 0.5 + dominant.count * 0.08) : 0.3,
    evidenceCount: dominant?.count ?? Math.max(extraEvidence, handoffEvidence, 0),
    updatedAt: nowIso(),
  };

  if (!manualProfile) {
    return inferred;
  }

  return {
    ...inferred,
    ...manualProfile,
    studentKey,
    studentName: manualProfile.studentName || studentName,
    course: manualProfile.course ? normalizeRoutineCourse(manualProfile.course) : inferred.course,
    teachingType: manualProfile.teachingType ? normalizeRoutineTeachingType(manualProfile.teachingType) : inferred.teachingType,
    weekday: manualProfile.weekday ?? inferred.weekday,
    time: manualProfile.time ?? inferred.time,
    durationMinutes: manualProfile.durationMinutes ?? inferred.durationMinutes,
    expectedKinds: deriveExpectedKindsFromRoutine(
      manualProfile.course ? normalizeRoutineCourse(manualProfile.course) : inferred.course,
      manualProfile.teachingType ? normalizeRoutineTeachingType(manualProfile.teachingType) : inferred.teachingType,
      {
        ...inferred.expectedKinds,
        ...normalizeRoutineExpectedKinds(manualProfile.expectedKinds),
      },
    ),
    note: manualProfile.note ?? inferred.note,
    source: "manual",
    confidence: 1,
  };
}

function recurringTimeSuggestion(
  events: Array<{
    title: string;
    start: string;
    end?: string;
    id: string;
    extendedProps?: {
      accountId?: string;
      googleCalendarId?: string;
      googleEventId?: string;
    };
  }>,
  studentName: string,
  targetDate: string,
): { start: string; end: string; title: string } | null {
  const sameStudent = events.filter((event) => {
    const eventStudent = normalizeStudentName(event.title);
    return normalizeName(eventStudent) === normalizeName(studentName) || isLikelySameStudent(eventStudent, studentName);
  });
  if (sameStudent.length < 3) {
    return null;
  }

  const counts = new Map<string, { count: number; durationMinutes: number }>();
  for (const event of sameStudent) {
    const key = timePartOf(event.start);
    const durationMinutes = Math.max(30, Math.round((new Date(event.end ?? addMinutes(event.start, 60)).getTime() - new Date(event.start).getTime()) / 60000));
    const current = counts.get(key) ?? { count: 0, durationMinutes };
    current.count += 1;
    counts.set(key, current);
  }
  const ranked = Array.from(counts.entries()).sort((left, right) => right[1].count - left[1].count);
  const [time, info] = ranked[0] ?? [];
  if (!time || !info || info.count < 3) {
    return null;
  }
  const start = formatIsoWithOffset(targetDate, time);
  return {
    start,
    end: addMinutes(start, info.durationMinutes || 60),
    title: `${displayStudentName(studentName)}さん`,
  };
}

function eventDurationMinutes(event: {
  start: string;
  end?: string;
}): number {
  return Math.max(30, Math.round((new Date(event.end ?? addMinutes(event.start, 60)).getTime() - new Date(event.start).getTime()) / 60000));
}

function timeToMinutes(time: string | undefined): number {
  const match = String(time || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return 0;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function dominantRecurringBaseline(
  events: Array<{
    id: string;
    title: string;
    start: string;
    end?: string;
  }>,
  studentName: string,
  excludeEventId?: string,
): { weekday: number; time: string; durationMinutes: number; count: number } | null {
  const sameStudent = events.filter((event) => {
    if (excludeEventId && event.id === excludeEventId) {
      return false;
    }
    const eventStudent = normalizeStudentName(event.title);
    return normalizeName(eventStudent) === normalizeName(studentName) || isLikelySameStudent(eventStudent, studentName);
  });
  if (sameStudent.length < 3) {
    return null;
  }

  const buckets = new Map<string, { count: number; durationMinutesTotal: number; weekday: number; time: string }>();
  for (const event of sameStudent) {
    const weekday = weekdayOf(event.start.slice(0, 10));
    const time = timePartOf(event.start);
    const key = `${weekday}|${time}`;
    const current = buckets.get(key) ?? { count: 0, durationMinutesTotal: 0, weekday, time };
    current.count += 1;
    current.durationMinutesTotal += eventDurationMinutes(event);
    buckets.set(key, current);
  }

  const ranked = Array.from(buckets.values()).sort((left, right) => right.count - left.count);
  const winner = ranked[0];
  if (!winner || winner.count < 3) {
    return null;
  }
  return {
    weekday: winner.weekday,
    time: winner.time,
    durationMinutes: Math.max(30, Math.round(winner.durationMinutesTotal / winner.count)),
    count: winner.count,
  };
}

function nearestExpectedDateAround(targetDate: string, weekday: number): string {
  const base = new Date(`${targetDate}T00:00:00+09:00`);
  const targetWeekday = base.getDay();
  let bestDate = targetDate;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let offset = -7; offset <= 7; offset += 1) {
    const candidate = new Date(base.getTime() + offset * 86_400_000);
    if (candidate.getDay() !== weekday) {
      continue;
    }
    const distance = Math.abs(offset);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestDate = inferDateFromIso(candidate.toISOString());
    }
  }
  return bestDate;
}

function inferWorkflowSuggestions(
  record: ReconciliationRecord,
  events: Array<{
    id: string;
    title: string;
    start: string;
    end?: string;
    extendedProps?: {
      description?: string;
    };
  }>,
): WorkflowAutofillSuggestion[] {
  if (record.ignored || record.source !== "calendar" || record.kind !== "main" || !looksLikeStudentEntity(record.studentName)) {
    return [];
  }
  const legacyHandoff = isLegacyHandoffYear(record.start);

  const event = events.find((item) => item.id === record.sessionIds[0]);
  if (!event) {
    return [];
  }

  const profileBaseline = record.studentRoutineProfile?.weekday !== null
    && record.studentRoutineProfile?.weekday !== undefined
    && record.studentRoutineProfile?.time
    ? {
        weekday: record.studentRoutineProfile.weekday,
        time: record.studentRoutineProfile.time,
        durationMinutes: record.studentRoutineProfile.durationMinutes ?? 60,
        count: Math.max(3, record.studentRoutineProfile.evidenceCount || 3),
      }
    : null;
  const baseline = profileBaseline ?? dominantRecurringBaseline(events, record.studentName, event.id);
  const suggestions: WorkflowAutofillSuggestion[] = [];
  const eventDate = event.start.slice(0, 10);
  const eventTime = timePartOf(event.start);
  const eventWeekday = weekdayOf(eventDate);
  const description = normalizeText(event.extendedProps?.description);
  const title = normalizeText(event.title);
  const haystack = `${title}\n${description}`;

  if (baseline) {
    const timeDelta = Math.abs(timeToMinutes(eventTime) - timeToMinutes(baseline.time));
    if (eventWeekday !== baseline.weekday || timeDelta >= 30) {
      const originalDate = nearestExpectedDateAround(eventDate, baseline.weekday);
      suggestions.push({
        id: `${record.id}:workflow:schedule_change`,
        kind: "schedule_change",
        label: "日程変更",
        reason: `通例は ${["日", "月", "火", "水", "木", "金", "土"][baseline.weekday]} ${baseline.time} ですが、今回は ${["日", "月", "火", "水", "木", "金", "土"][eventWeekday]} ${eventTime} です。`,
        confidence: 0.82,
        preview: `${originalDate} ${baseline.time} -> ${eventDate} ${eventTime}`,
        originalDate,
        originalTime: baseline.time,
        targetDate: eventDate,
        targetTime: eventTime,
      });
    }

    const durationDelta = eventDurationMinutes(event) - baseline.durationMinutes;
    if (durationDelta >= 25 || requiresExtraThirty(event)) {
      const rounded = Math.max(30, Math.ceil(Math.max(durationDelta, 30) / 30) * 30);
      suggestions.push({
        id: `${record.id}:workflow:extra_thirty`,
        kind: "extra_thirty",
        label: "追加作業報告",
        reason: durationDelta >= 25
          ? `通常は ${baseline.durationMinutes} 分ですが、今回は ${eventDurationMinutes(event)} 分です。`
          : "タイトルや説明から追加30分申請が必要そうです。",
        confidence: durationDelta >= 25 ? 0.78 : 0.72,
        preview: `${Math.round(rounded / 30) * 30}分の追加作業報告`,
        durationMinutes: rounded,
      });
    }
  } else if (requiresExtraThirty(event)) {
    suggestions.push({
      id: `${record.id}:workflow:extra_thirty`,
      kind: "extra_thirty",
      label: "追加作業報告",
      reason: "タイトルや説明から追加30分申請が必要そうです。",
      confidence: 0.65,
      preview: "30分の追加作業報告",
      durationMinutes: 30,
    });
  }

  if (!legacyHandoff && /引き継ぎ|代行|振替/u.test(haystack)) {
    suggestions.push({
      id: `${record.id}:workflow:handoff`,
      kind: "handoff",
      label: "引き継ぎ",
      reason: "タイトルまたは説明に代行・引き継ぎ系の文言があります。",
      confidence: 0.74,
      preview: "代行引き継ぎ",
      handoffPolicy: "substitute",
    });
    suggestions.push({
      id: `${record.id}:workflow:handoff_five`,
      kind: "handoff_five",
      label: "引き継ぎ5分",
      reason: "引き継ぎ対応には5分間の作業時間申請も必要です。",
      confidence: 0.74,
      preview: "5分の引き継ぎ作業報告",
      handoffPolicy: "substitute",
      durationMinutes: 5,
    });
  }

  if (record.studentRoutineProfile?.expectedKinds.extra_thirty) {
    const teachingType = record.studentRoutineProfile?.teachingType;
    suggestions.push({
      id: `${record.id}:workflow:extra_thirty:profile`,
      kind: "extra_thirty",
      label: "追加作業報告",
      reason: teachingType === "essay_teaching"
        ? "生徒台帳でアドバンス/プレミアムの小論文ティーチングとして設定されています。"
        : teachingType === "past_exam_teaching"
          ? "生徒台帳でアドバンス/プレミアムの過去問ティーチングとして設定されています。"
          : "生徒台帳で追加30分を定例業務に設定しています。",
      confidence: 0.7,
      preview: "30分の追加作業報告",
      durationMinutes: 30,
    });
  }

  if (!legacyHandoff && record.studentRoutineProfile?.expectedKinds.handoff) {
    const course = record.studentRoutineProfile?.course;
    suggestions.push({
      id: `${record.id}:workflow:handoff:profile`,
      kind: "handoff",
      label: "引き継ぎ",
      reason: course === "advance" || course === "premium"
        ? "生徒台帳でアドバンス/プレミアムとして設定されているため、引き継ぎが必要です。"
        : "生徒台帳で引き継ぎを定例業務に設定しています。",
      confidence: 0.7,
      preview: "代行引き継ぎ",
      handoffPolicy: course === "advance" || course === "premium" ? "advance_premium" : "substitute",
    });
  }

  if (!legacyHandoff && record.studentRoutineProfile?.expectedKinds.handoff_five) {
    const course = record.studentRoutineProfile?.course;
    suggestions.push({
      id: `${record.id}:workflow:handoff_five:profile`,
      kind: "handoff_five",
      label: "引き継ぎ5分",
      reason: course === "advance" || course === "premium"
        ? "生徒台帳でアドバンス/プレミアムとして設定されているため、引き継ぎ5分申請が必要です。"
        : "生徒台帳で引き継ぎ5分申請を定例業務に設定しています。",
      confidence: 0.7,
      preview: "5分の引き継ぎ作業報告",
      handoffPolicy: course === "advance" || course === "premium" ? "advance_premium" : "substitute",
      durationMinutes: 5,
    });
  }

  return suggestions.filter((suggestion, index, array) =>
    array.findIndex((candidate) => candidate.kind === suggestion.kind) === index,
  );
}

function missingRequirementWorkflowSuggestion(
  kind: "handoff" | "handoff_five" | "extra_thirty",
  record: ReconciliationRecord,
): WorkflowAutofillSuggestion | null {
  if (isLegacyHandoffYear(record.start) && (kind === "handoff" || kind === "handoff_five")) {
    return null;
  }
  const course = record.studentRoutineProfile?.course;
  const teachingType = record.studentRoutineProfile?.teachingType;

  if (kind === "extra_thirty") {
    return {
      id: `${record.id}:workflow:extra_thirty:missing`,
      kind,
      label: "追加作業報告",
      reason: teachingType === "essay_teaching"
        ? "過去の申請履歴から、小論文ティーチングでは追加30分申請が必要なパターンと判断しました。"
        : teachingType === "past_exam_teaching"
          ? "過去の申請履歴から、過去問ティーチングでは追加30分申請が必要なパターンと判断しました。"
          : "過去の申請履歴から、追加30分申請が必要なパターンと判断しました。",
      confidence: 0.68,
      preview: "30分の追加作業報告",
      durationMinutes: 30,
    };
  }

  if (kind === "handoff") {
    return {
      id: `${record.id}:workflow:handoff:missing`,
      kind,
      label: "引き継ぎ",
      reason: course === "advance" || course === "premium"
        ? "過去の申請履歴から、アドバンス/プレミアムでは引き継ぎ申請が必要なパターンと判断しました。"
        : "過去の申請履歴から、引き継ぎ申請が必要なパターンと判断しました。",
      confidence: 0.68,
      preview: "代行引き継ぎ",
      handoffPolicy: course === "advance" || course === "premium" ? "advance_premium" : "substitute",
    };
  }

  return {
    id: `${record.id}:workflow:handoff_five:missing`,
    kind,
    label: "引き継ぎ5分",
    reason: course === "advance" || course === "premium"
      ? "過去の申請履歴から、アドバンス/プレミアムでは引き継ぎ5分申請が必要なパターンと判断しました。"
      : "過去の申請履歴から、引き継ぎ5分申請が必要なパターンと判断しました。",
    confidence: 0.68,
    preview: "5分の引き継ぎ作業報告",
    handoffPolicy: course === "advance" || course === "premium" ? "advance_premium" : "substitute",
    durationMinutes: 5,
  };
}

function mergeWorkflowSuggestions(
  base: WorkflowAutofillSuggestion[],
  extras: WorkflowAutofillSuggestion[],
): WorkflowAutofillSuggestion[] {
  return [...base, ...extras].filter((suggestion, index, array) =>
    array.findIndex((candidate) => candidate.kind === suggestion.kind) === index,
  );
}

function buildPayload(fieldSpecs: TaskPayload["fieldSpecs"], answers: TaskPayload["answers"], reviewHints: string[]): TaskPayload {
  return {
    fieldSpecs,
    answers,
    reviewHints,
  };
}

function canonicalStudentName(value: string | undefined): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/^[\p{Z}\s\u200B-\u200D\uFEFF]+|[\p{Z}\s\u200B-\u200D\uFEFF]+$/gu, "")
    .replace(/【.*?】/g, " ")
    .replace(/\[.*?\]/g, " ")
    .replace(/（.*?）/g, " ")
    .replace(/\(.*?\)/g, " ")
    .replace(/(?:さん|様|くん|君|ちゃん)\s*$/u, "")
    .replace(/[\p{Z}\s]+/gu, " ")
    .trim();
}

function normalizeName(value: string | undefined): string {
  return canonicalStudentName(value)
    .replace(/\s+/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toLowerCase();
}

function isLikelySameStudent(left: string | undefined, right: string | undefined): boolean {
  const leftKey = normalizeName(left);
  const rightKey = normalizeName(right);
  if (!leftKey || !rightKey || leftKey === "未特定" || rightKey === "未特定") {
    return false;
  }
  if (leftKey === rightKey) {
    return true;
  }
  if (leftKey.length !== rightKey.length || leftKey.length < 3) {
    return false;
  }

  let mismatches = 0;
  for (let index = 0; index < leftKey.length; index += 1) {
    if (leftKey[index] !== rightKey[index]) {
      mismatches += 1;
      if (mismatches > 1) {
        return false;
      }
    }
  }
  return mismatches === 1;
}

function normalizeStudentName(title: string): string {
  const raw = String(title ?? "").trim();
  if (!raw) {
    return "未特定";
  }

  let text = canonicalStudentName(raw)
    .replace(/\s+/g, " ")
    .trim();

  for (const splitter of [" / ", "／", "｜", "|", " - ", "：", ":"]) {
    if (text.includes(splitter)) {
      text = text.split(splitter)[0]?.trim() ?? text;
      break;
    }
  }

  text = text
    .replace(/コーチング/gi, "")
    .replace(/面談/gi, "")
    .replace(/授業/gi, "")
    .replace(/session/gi, "")
    .replace(/セッション/gi, "")
    .trim();

  return text.length >= 2 ? text : "未特定";
}

function displayStudentName(value: string | undefined): string {
  const text = canonicalStudentName(value);
  const compact = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)
    && !/[A-Za-z0-9]/.test(text)
    ? text.replace(/\s+/g, "")
    : text;
  return compact || "未特定";
}

function looksLikeStudentEntity(value: string | undefined): boolean {
  const text = displayStudentName(value);
  if (!text || text === "未特定") {
    return false;
  }
  if (/営業時間|貸切|利用|勉強会|イベント|スペース|OASIS|候補/u.test(text)) {
    return false;
  }
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);
}

function submissionKind(submission: GmailSubmissionRecord): ReconciliationKind {
  if (submission.formKey === "schedule_change") {
    return "schedule_change";
  }
  if (submission.formKey === "handoff") {
    return "handoff";
  }
  const intent = workReportIntent(submission);
  if (intent === "main") {
    return "main";
  }
  if (intent === "extra_thirty") {
    return "extra_thirty";
  }
  if (intent === "handoff") {
    return "handoff_five";
  }
  if (intent === "administrative") {
    return /研修|動画/u.test(`${submission.workReport?.taskLabel ?? ""}\n${submission.workReport?.detailedTask ?? ""}`) ? "training" : "administrative";
  }
  return "unknown";
}

function requiredKindsForEvent(
  event: {
    title: string;
    start?: string;
    extendedProps?: { description?: string };
  },
): ReconciliationKind[] {
  const kinds: ReconciliationKind[] = ["main"];
  if (requiresExtraThirty(event)) {
    kinds.push("extra_thirty");
  }
  if (!isLegacyHandoffYear(event.start ?? Date.now()) && requiresHandoff(event)) {
    kinds.push("handoff");
    kinds.push("handoff_five");
  }
  return kinds;
}

const jstDayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function jstDayKey(value: string | number | Date): string {
  return jstDayFormatter.format(new Date(value));
}

function jstDayDiff(start: string): number {
  return diffDays(jstDayKey(Date.now()), jstDayKey(start));
}

function fiscalYearOfJstDate(value: string | number | Date): number {
  const [yearText, monthText] = jstDayKey(value).split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  return month >= 4 ? year : year - 1;
}

const HANDOFF_REQUIRED_FROM_JST_DAY = "2026-03-01";

function isLegacyHandoffYear(value: string | number | Date): boolean {
  return jstDayKey(value) < HANDOFF_REQUIRED_FROM_JST_DAY;
}

function deriveApplicationStatus(start: string): "upcoming" | "draft" | "review" | "stale" {
  const startTime = new Date(start).getTime();
  if (Number.isFinite(startTime) && startTime > Date.now()) {
    return "upcoming";
  }
  const dayDiff = jstDayDiff(start);
  if (dayDiff === 0) {
    return "draft";
  }
  return "stale";
}

function diffDays(left: string, right: string): number {
  const leftDate = new Date(`${left}T00:00:00+09:00`).getTime();
  const rightDate = new Date(`${right}T00:00:00+09:00`).getTime();
  return Math.round((leftDate - rightDate) / 86_400_000);
}

function daysSince(start: string): number {
  return Math.max(0, jstDayDiff(start));
}

function scoreSubmissionMatch(
  event: {
    title: string;
    start: string;
  },
  submission: GmailSubmissionRecord,
): number {
  const studentName = normalizeStudentName(event.title);
  const sameStudent = normalizeName(submission.studentName) === normalizeName(studentName)
    || isLikelySameStudent(submission.studentName, studentName);
  if (!sameStudent) {
    return -1;
  }

  if (isSupplementalWorkReport(submission) || submission.formKey === "handoff") {
    return -1;
  }

  if (submission.formKey === "schedule_change" && submission.scheduleChange?.targetDate) {
    const eventDate = event.start.slice(0, 10);
    const delta = Math.abs(diffDays(eventDate, submission.scheduleChange.targetDate));
    const eventTime = new Date(event.start).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false });
    const sameTime = submission.scheduleChange.targetTime
      ? eventTime === submission.scheduleChange.targetTime
      : true;
    if (delta === 0 && sameTime) {
      return 24;
    }
    if (delta === 0) {
      return 18;
    }
    if (delta <= 1) {
      return 12;
    }
    return -1;
  }

  let score = 10;
  const sessionDate = event.start.slice(0, 10);
  if (submission.sessionDate) {
    const delta = Math.abs(diffDays(sessionDate, submission.sessionDate));
    if (delta === 0) {
      score += 6;
    } else if (delta === 1) {
      score += 2;
    } else {
      score -= 3;
    }
  }

  if (submission.formKey === "work_report") {
    score += 2;
  }

  return score;
}

function buildScheduleChangeTitle(submission: GmailSubmissionRecord): string {
  const original = formatScheduleChangeDateLabel(
    submission.scheduleChange?.originalDate,
    submission.scheduleChange?.originalTime,
    { includeYear: true },
  );
  const target = formatScheduleChangeDateLabel(
    submission.scheduleChange?.targetDate,
    submission.scheduleChange?.targetTime,
    { includeYear: false },
  );
  return `${original} → ${target}`;
}

function derivedSubmissionStart(submission: GmailSubmissionRecord): string {
  if (submission.formKey === "schedule_change" && submission.scheduleChange?.targetDate) {
    return `${submission.scheduleChange.targetDate}T${submission.scheduleChange.targetTime ?? "00:00"}:00+09:00`;
  }
  if (submission.formKey === "work_report" && submission.sessionDate) {
    return `${submission.sessionDate}T12:00:00+09:00`;
  }
  return submission.submittedAt;
}

function scheduleChangeAttentionReason(
  submission: GmailSubmissionRecord,
  events: Array<{
    title: string;
    start: string;
  }>,
): string {
  const targetDate = submission.scheduleChange?.targetDate;
  const targetTime = submission.scheduleChange?.targetTime;
  const originalDate = submission.scheduleChange?.originalDate;
  const originalTime = submission.scheduleChange?.originalTime;
  const studentName = submission.studentName;

  const base = `${originalDate ?? "通常日時不明"}${originalTime ? ` ${originalTime}` : ""} -> ${targetDate ?? "変更後日時不明"}${targetTime ? ` ${targetTime}` : ""}`;
  if (!studentName || !targetDate) {
    return `${base} / 日程変更内容の読み取りに失敗しています。`;
  }

  const sameStudentEvents = events.filter((event) => normalizeName(normalizeStudentName(event.title)) === normalizeName(studentName));
  const targetMatched = sameStudentEvents.some((event) => {
    const eventDate = event.start.slice(0, 10);
    const eventTime = new Date(event.start).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false });
    return eventDate === targetDate && (!targetTime || eventTime === targetTime);
  });
  const originalStillExists = originalDate
    ? sameStudentEvents.some((event) => {
        const eventDate = event.start.slice(0, 10);
        const eventTime = new Date(event.start).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false });
        return eventDate === originalDate && (!originalTime || eventTime === originalTime);
      })
    : false;

  if (targetMatched && originalStillExists) {
    return `${base} / カレンダー上で旧予定と新予定が両方見えます。重複確認が必要です。`;
  }
  if (targetMatched) {
    return `${base} / 変更後の日時はカレンダーと一致しています。`;
  }
  return `${base} / 変更後の日時がカレンダー上で見つかりません。`;
}

function attentionReason(status: "upcoming" | "draft" | "review" | "stale", start: string): string {
  const elapsedDays = daysSince(start);
  if (status === "draft") {
    return elapsedDays <= 0
      ? "当日の予定です。申請の確認が必要です。"
      : `予定後 ${elapsedDays} 日です。申請の確認が必要です。`;
  }
  if (status === "review") {
    return `予定後 ${elapsedDays} 日です。送信漏れか照合漏れの確認が必要です。`;
  }
  if (status === "stale") {
    return `予定後 ${elapsedDays} 日です。優先して確認してください。`;
  }
  return `次回は ${new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric" }).format(new Date(start))} です。`;
}

function requiresExtraThirty(event: {
  title: string;
  extendedProps?: { description?: string };
}): boolean {
  const haystack = `${event.title} ${event.extendedProps?.description ?? ""}`;
  return /過去問|小論文|ティーチング/iu.test(haystack);
}

function requiresHandoff(event: {
  title: string;
  extendedProps?: { description?: string };
}): boolean {
  const haystack = `${event.title} ${event.extendedProps?.description ?? ""}`;
  return /引き継ぎ/iu.test(haystack);
}

function workReportIntent(
  submission: GmailSubmissionRecord,
): "main" | "extra_thirty" | "handoff" | "administrative" | "other" | null {
  if (submission.formKey !== "work_report") {
    return null;
  }
  if (submission.workReport?.intent) {
    return submission.workReport.intent;
  }

  const taskText = `${submission.workReport?.taskLabel ?? ""}\n${submission.workReport?.detailedTask ?? ""}`;
  if (/研修|研修動画|動画の視聴|動画視聴|フォームの回答|全体研修/u.test(taskText)) {
    return "administrative";
  }
  if (/引き継ぎ/u.test(taskText)) {
    return "handoff";
  }
  if (/小論文|ティーチング|過去問|添削|準備|時間外作業/u.test(taskText)) {
    return "extra_thirty";
  }
  if (submission.workReport?.taskCategory === "コーチング" || submission.workReport?.taskCategory === "コーチング業務") {
    return "main";
  }
  if (submission.workReport?.taskCategory === "コーチング以外") {
    return "other";
  }
  return null;
}

function supplementalWorkReportKind(
  submission: GmailSubmissionRecord,
): "handoff_five" | "extra_thirty" | "other" | null {
  if (submission.formKey !== "work_report") {
    return null;
  }

  const intent = workReportIntent(submission);
  if (intent === "handoff") {
    return "handoff_five";
  }
  if (intent === "extra_thirty") {
    return "extra_thirty";
  }
  if (intent === "other") {
    return "other";
  }
  return null;
}

function submissionDateForMatch(submission: GmailSubmissionRecord): string {
  return submission.sessionDate ?? submission.submittedAt.slice(0, 10);
}

function submissionTargetsStudent(submission: GmailSubmissionRecord, studentName: string): boolean {
  const target = normalizeName(studentName);
  if (!target) {
    return false;
  }

  if (normalizeName(submission.studentName) === target || isLikelySameStudent(submission.studentName, studentName)) {
    return true;
  }

  return [
    ...(submission.workReport?.inferredStudentNames ?? []),
    ...(submission.workReport?.inferredHandoffStudentNames ?? []),
  ].some((name) => normalizeName(name) === target || isLikelySameStudent(name, studentName));
}

function isInferredHandoffSubmission(submission: GmailSubmissionRecord): boolean {
  return supplementalWorkReportKind(submission) === "handoff_five";
}

function isExtraThirtySubmission(submission: GmailSubmissionRecord): boolean {
  return supplementalWorkReportKind(submission) === "extra_thirty";
}

function isSupplementalWorkReport(submission: GmailSubmissionRecord): boolean {
  return supplementalWorkReportKind(submission) !== null;
}

function isGenericHandoffSubmission(submission: GmailSubmissionRecord): boolean {
  return isInferredHandoffSubmission(submission) && (submission.workReport?.inferredHandoffStudentNames?.length ?? 0) === 0;
}

function isAdministrativeWorkReport(submission: GmailSubmissionRecord): boolean {
  return workReportIntent(submission) === "administrative";
}

function candidateStudentNames(submission: GmailSubmissionRecord): string[] {
  return Array.from(new Set([
    submission.studentName,
    ...(submission.workReport?.inferredStudentNames ?? []),
    ...(submission.workReport?.inferredHandoffStudentNames ?? []),
  ].filter(Boolean))) as string[];
}

function submissionReviewReason(
  submission: GmailSubmissionRecord,
  events: Array<{
    title: string;
    start: string;
  }>,
): string {
  const supplementalKind = supplementalWorkReportKind(submission);
  if (submission.formKey === "schedule_change") {
    return scheduleChangeAttentionReason(submission, events);
  }
  if (supplementalKind === "extra_thirty") {
    return "小論文・ティーチングなどの追加30分申請です。通常予定との照合が必要です。";
  }
  if (supplementalKind === "handoff_five") {
    return "引き継ぎ5分申請です。対象生徒との照合が必要です。";
  }
  return "申請は見つかりましたが、予定に紐付いていません。";
}

function submissionEventDate(submission: GmailSubmissionRecord): string | undefined {
  if (submission.formKey === "schedule_change") {
    return submission.scheduleChange?.targetDate ?? submission.scheduleChange?.originalDate;
  }
  return submission.sessionDate;
}

function hasResolvableEventForSubmission(
  submission: GmailSubmissionRecord,
  events: Array<{
    title: string;
    start: string;
  }>,
  submissions: GmailSubmissionRecord[],
): boolean {
  const targets = candidateStudentNames(submission);
  if (targets.length === 0) {
    return false;
  }

  const targetDate = submissionEventDate(submission);
  const windowDays = isInferredHandoffSubmission(submission) ? 14 : isSupplementalWorkReport(submission) ? 7 : 0;

  return events.some((event) => {
    const eventStudent = normalizeStudentName(event.title);
    const matchesStudent = targets.some((name) => normalizeName(name) === normalizeName(eventStudent));
    if (!matchesStudent) {
      return false;
    }
    if (!targetDate) {
      return true;
    }
    const delta = Math.abs(diffDays(event.start.slice(0, 10), targetDate));
    return delta <= windowDays;
  }) || (
    submission.formKey === "work_report"
      && !isSupplementalWorkReport(submission)
      && Boolean(submission.sessionDate)
      && submissions.some((candidate) => {
        if (candidate.formKey !== "schedule_change" || !candidate.scheduleChange?.originalDate || !candidate.scheduleChange?.targetDate) {
          return false;
        }
        const sameStudent = normalizeName(candidate.studentName) === normalizeName(submission.studentName)
          || isLikelySameStudent(candidate.studentName, submission.studentName);
        if (!sameStudent || candidate.scheduleChange.originalDate !== submission.sessionDate) {
          return false;
        }
        return events.some((event) => {
          const eventStudent = normalizeStudentName(event.title);
          const studentMatches = normalizeName(eventStudent) === normalizeName(submission.studentName)
            || isLikelySameStudent(eventStudent, submission.studentName);
          return studentMatches && event.start.slice(0, 10) === candidate.scheduleChange?.targetDate;
        });
      })
  );
}

function eventDisplayState(
  event: {
    title: string;
    start: string;
    extendedProps?: { description?: string };
  },
  submissions: GmailSubmissionRecord[],
  expectedKinds?: Partial<StudentRoutineProfile["expectedKinds"]>,
): "missing" | "partial" | "complete" {
  const legacyHandoff = isLegacyHandoffYear(event.start);
  const studentName = normalizeStudentName(event.title);
  const sessionDate = event.start.slice(0, 10);
  const sameStudent = submissions.filter((submission) =>
    submissionTargetsStudent(submission, studentName),
  );

  const nearby = sameStudent.filter((submission) => {
    const delta = Math.abs(diffDays(sessionDate, submissionDateForMatch(submission)));
    if (submission.formKey === "handoff") {
      return delta <= 31;
    }
    return delta <= 1;
  });

  const mainReports = nearby.filter((submission) =>
    submission.formKey === "work_report" && !isSupplementalWorkReport(submission),
  );
  const extraReports = nearby.filter((submission) => isExtraThirtySubmission(submission));
  const historicalExtraReports = sameStudent.filter((submission) => isExtraThirtySubmission(submission));
  const historicalHandoffReports = legacyHandoff
    ? []
    : sameStudent.filter((submission) =>
        !isLegacyHandoffYear(`${submissionDateForMatch(submission)}T00:00:00+09:00`)
        && (submission.formKey === "handoff" || isInferredHandoffSubmission(submission)),
      );
  const hasScheduleChange = nearby.some((submission) => submission.formKey === "schedule_change");
  const hasMain = mainReports.length > 0 || hasScheduleChange;

  if (!hasMain) {
    return "missing";
  }

  const needsExtra = requiresExtraThirty(event) || historicalExtraReports.length >= 3 || Boolean(expectedKinds?.extra_thirty);
  const needsHandoff = !legacyHandoff && (
    requiresHandoff(event) || historicalHandoffReports.length >= 2 || Boolean(expectedKinds?.handoff) || Boolean(expectedKinds?.handoff_five)
  );
  const hasExtra = extraReports.length > 0 || mainReports.length >= 2;
  const hasHandoffForm = nearby.some((submission) => submission.formKey === "handoff");
  const hasHandoffFive = nearby.some((submission) => isInferredHandoffSubmission(submission));

  if ((needsExtra && !hasExtra) || (needsHandoff && (!hasHandoffForm || !hasHandoffFive))) {
    return "partial";
  }

  return "complete";
}

function eventMissingRequirements(
  event: {
    title: string;
    start: string;
    extendedProps?: { description?: string };
  },
  submissions: GmailSubmissionRecord[],
  expectedKinds?: Partial<StudentRoutineProfile["expectedKinds"]>,
): Array<"handoff" | "handoff_five" | "extra_thirty"> {
  const legacyHandoff = isLegacyHandoffYear(event.start);
  const studentName = normalizeStudentName(event.title);
  const sessionDate = event.start.slice(0, 10);
  const sameStudent = submissions.filter((submission) =>
    submissionTargetsStudent(submission, studentName),
  );

  const nearby = sameStudent.filter((submission) => {
    const delta = Math.abs(diffDays(sessionDate, submissionDateForMatch(submission)));
    if (submission.formKey === "handoff") {
      return delta <= 14;
    }
    return delta <= 1;
  });

  const mainReports = nearby.filter((submission) =>
    submission.formKey === "work_report" && !isSupplementalWorkReport(submission),
  );
  const extraReports = nearby.filter((submission) => isExtraThirtySubmission(submission));
  const historicalExtraReports = sameStudent.filter((submission) => isExtraThirtySubmission(submission));
  const historicalHandoffReports = legacyHandoff
    ? []
    : sameStudent.filter((submission) =>
        !isLegacyHandoffYear(`${submissionDateForMatch(submission)}T00:00:00+09:00`)
        && (submission.formKey === "handoff" || isInferredHandoffSubmission(submission)),
      );
  const needsExtra = requiresExtraThirty(event) || historicalExtraReports.length >= 3 || Boolean(expectedKinds?.extra_thirty);
  const needsHandoff = !legacyHandoff && (
    requiresHandoff(event) || historicalHandoffReports.length >= 2 || Boolean(expectedKinds?.handoff) || Boolean(expectedKinds?.handoff_five)
  );
  const hasExtra = extraReports.length > 0 || mainReports.length >= 2;
  const hasHandoffForm = nearby.some((submission) => submission.formKey === "handoff");
  const hasHandoffFive = nearby.some((submission) => isInferredHandoffSubmission(submission));
  const missing: Array<"handoff" | "handoff_five" | "extra_thirty"> = [];
  if (needsHandoff && !hasHandoffForm) {
    missing.push("handoff");
  }
  if (needsHandoff && !hasHandoffFive) {
    missing.push("handoff_five");
  }
  if (needsExtra && !hasExtra) {
    missing.push("extra_thirty");
  }
  return missing;
}

function missingRequirementsAttention(
  missing: Array<"handoff" | "handoff_five" | "extra_thirty">,
): string {
  const hasHandoff = missing.includes("handoff");
  const hasHandoffFive = missing.includes("handoff_five");
  const hasExtraThirty = missing.includes("extra_thirty");

  if (hasHandoff && hasHandoffFive && hasExtraThirty) {
    return "本体申請はありますが、引き継ぎフォーム・引き継ぎ5分申請・追加30分が不足しています。";
  }
  if (hasHandoff && hasHandoffFive) {
    return "本体申請はありますが、引き継ぎフォームと引き継ぎ5分申請が不足しています。";
  }
  if (hasHandoff && hasExtraThirty) {
    return "本体申請はありますが、引き継ぎフォームと追加30分が不足しています。";
  }
  if (hasHandoffFive && hasExtraThirty) {
    return "本体申請はありますが、引き継ぎ5分申請と追加30分が不足しています。";
  }
  if (hasHandoff) {
    return "本体申請はありますが、引き継ぎフォームが不足しています。";
  }
  if (hasHandoffFive) {
    return "本体申請はありますが、引き継ぎ5分申請が不足しています。";
  }
  if (hasExtraThirty) {
    return "本体申請はありますが、追加30分が不足しています。";
  }
  return "本体申請はありますが、必要な追加申請が不足しています。";
}

function calendarStateColors(state: "missing" | "partial" | "complete"): {
  backgroundColor: string;
  borderColor: string;
  textColor: string;
} {
  if (state === "complete") {
    return {
      backgroundColor: "#d9f1df",
      borderColor: "#86c79b",
      textColor: "#111111",
    };
  }
  if (state === "partial") {
    return {
      backgroundColor: "#fff1b8",
      borderColor: "#e0c15a",
      textColor: "#111111",
    };
  }
  return {
    backgroundColor: "#f9d4d0",
    borderColor: "#de8a84",
    textColor: "#111111",
  };
}

function decorateCalendarEvents<T extends {
  title: string;
  start: string;
  extendedProps?: { description?: string };
}>(events: T[], submissions: GmailSubmissionRecord[], runtimeState: ReturnType<typeof loadRuntimeState>): Array<T & {
  backgroundColor: string;
  borderColor: string;
  textColor: string;
}> {
  return events.map((event) => {
    const ignored = Boolean(runtimeState.reconciliationOverrides[`rec:${(event as { id?: string }).id}`]?.ignored);
    const colors = ignored
      ? {
          backgroundColor: "#e6eaee",
          borderColor: "#b7c0c9",
          textColor: "#425266",
        }
      : calendarStateColors(eventDisplayState(event, submissions));
    return {
      ...event,
      ...colors,
    };
  });
}

function determineRecordKindFromEvent(
  event: {
    title: string;
    extendedProps?: { description?: string };
  },
  matched: GmailSubmissionRecord | null,
): ReconciliationKind {
  if (matched) {
    return submissionKind(matched);
  }
  return "main";
}

function sourceSnapshotFromEvent(event: {
  id: string;
  title: string;
  start: string;
  end?: string;
}): SourceSnapshot {
  return {
    id: event.id,
    title: event.title,
    start: event.start,
    end: event.end,
    source: "calendar",
  };
}

function sourceSnapshotFromSubmission(submission: GmailSubmissionRecord): SourceSnapshot {
  return {
    id: submission.id,
    title: submission.formKey === "schedule_change" ? buildScheduleChangeTitle(submission) : submission.formLabel,
    start: derivedSubmissionStart(submission),
    source: "gmail",
  };
}

function findScheduleChangeSuggestion(
  record: ReconciliationRecord,
  events: Array<{
    id: string;
    title: string;
    start: string;
    end?: string;
    extendedProps?: {
      accountId?: string;
      googleCalendarId?: string;
      googleEventId?: string;
      canEdit?: boolean;
    };
  }>,
): CalendarActionSuggestion[] {
  if (record.kind !== "schedule_change" || !record.submission?.scheduleChange) {
    return [];
  }

  const schedule = record.submission.scheduleChange;
  if (!schedule.targetDate || !schedule.targetTime) {
    return [];
  }

  const targetStart = formatIsoWithOffset(schedule.targetDate, schedule.targetTime);
  const matchingTarget = events.find((event) => {
    const student = normalizeStudentName(event.title);
    return (normalizeName(student) === normalizeName(record.studentName) || isLikelySameStudent(student, record.studentName))
      && event.start === targetStart;
  });
  if (matchingTarget) {
    return [];
  }

  const originalCandidate = events
    .filter((event) => {
      const student = normalizeStudentName(event.title);
      const sameStudent = normalizeName(student) === normalizeName(record.studentName) || isLikelySameStudent(student, record.studentName);
      if (!sameStudent || !schedule.originalDate) {
        return false;
      }
      return event.start.slice(0, 10) === schedule.originalDate;
    })
    .sort((left, right) => {
      if (!schedule.originalTime) {
        return 0;
      }
      const leftDelta = Math.abs(Number(timePartOf(left.start).replace(":", "")) - Number(schedule.originalTime.replace(":", "")));
      const rightDelta = Math.abs(Number(timePartOf(right.start).replace(":", "")) - Number(schedule.originalTime.replace(":", "")));
      return leftDelta - rightDelta;
    })[0];

  if (
    originalCandidate?.extendedProps?.accountId
    && originalCandidate.extendedProps?.googleCalendarId
    && originalCandidate.extendedProps?.googleEventId
    && originalCandidate.extendedProps?.canEdit
  ) {
    const durationMinutes = Math.max(
      30,
      Math.round((new Date(originalCandidate.end ?? addMinutes(originalCandidate.start, 60)).getTime() - new Date(originalCandidate.start).getTime()) / 60000),
    );
    return [{
      id: `${record.id}:move`,
      type: "move",
      label: schedule.originalDate === schedule.targetDate ? "時間を変更" : "予定を移動",
      reason: schedule.originalDate === schedule.targetDate
        ? "同日内の時間変更として処理できます。"
        : "元の予定を日程変更後の日時へ移動できます。",
      title: originalCandidate.title,
      start: targetStart,
      end: addMinutes(targetStart, durationMinutes),
      sourceEvent: {
        id: originalCandidate.id,
        accountId: originalCandidate.extendedProps.accountId,
        googleCalendarId: originalCandidate.extendedProps.googleCalendarId,
        googleEventId: originalCandidate.extendedProps.googleEventId,
        title: originalCandidate.title,
      },
    }];
  }

  return [{
    id: `${record.id}:create`,
    type: "create",
    label: "予定を作成",
    reason: "変更後日時に対応する予定がないため、新規作成できます。",
    title: `${displayStudentName(record.studentName)}さん`,
    start: targetStart,
    end: addMinutes(targetStart, 60),
  }];
}

function findUnmatchedMainSuggestion(
  record: ReconciliationRecord,
  events: Array<{
    id: string;
    title: string;
    start: string;
    end?: string;
    extendedProps?: {
      accountId?: string;
      googleCalendarId?: string;
      googleEventId?: string;
      canEdit?: boolean;
    };
  }>,
): CalendarActionSuggestion[] {
  if (record.kind !== "main" || record.source !== "gmail" || !record.submission?.sessionDate) {
    return [];
  }

  const targetStart = record.start;
  const sameStudentEvents = events.filter((event) => {
    const student = normalizeStudentName(event.title);
    return normalizeName(student) === normalizeName(record.studentName) || isLikelySameStudent(student, record.studentName);
  });

  if (sameStudentEvents.some((event) => event.start === targetStart)) {
    return [];
  }

  const movableCandidate = sameStudentEvents
    .filter((event) =>
      event.extendedProps?.accountId
      && event.extendedProps?.googleCalendarId
      && event.extendedProps?.googleEventId
      && event.extendedProps?.canEdit
    )
    .sort((left, right) => Math.abs(new Date(left.start).getTime() - new Date(targetStart).getTime()) - Math.abs(new Date(right.start).getTime() - new Date(targetStart).getTime()))[0];

  if (movableCandidate) {
    const sourceEvent = movableCandidate.extendedProps;
    const durationMinutes = Math.max(
      30,
      Math.round((new Date(movableCandidate.end ?? addMinutes(movableCandidate.start, 60)).getTime() - new Date(movableCandidate.start).getTime()) / 60000),
    );
    return [{
      id: `${record.id}:move`,
      type: "move",
      label: "予定を移動",
      reason: "同じ生徒の既存予定が別日に残っているため、申請日時へ移動できます。",
      title: movableCandidate.title,
      start: targetStart,
      end: addMinutes(targetStart, durationMinutes),
      sourceEvent: {
        id: movableCandidate.id,
        accountId: sourceEvent!.accountId!,
        googleCalendarId: sourceEvent!.googleCalendarId!,
        googleEventId: sourceEvent!.googleEventId!,
        title: movableCandidate.title,
      },
    }];
  }

  const suggestion = recurringTimeSuggestion(events, record.studentName, record.submission.sessionDate);
  if (!suggestion) {
    return [];
  }

  const duplicate = sameStudentEvents.some((event) => event.start === suggestion.start);
  if (duplicate) {
    return [];
  }

  return [{
    id: `${record.id}:create`,
    type: "create",
    label: "予定を作成",
    reason: "同じ生徒の過去予定から時刻を推測して予定を作成できます。",
    title: suggestion.title,
    start: suggestion.start,
    end: suggestion.end,
  }];
}

function recordKindLabel(kind: ReconciliationKind): string {
  return {
    main: "本体申請",
    schedule_change: "日程変更",
    handoff: "引き継ぎ",
    handoff_five: "引き継ぎ5分",
    extra_thirty: "追加30分",
    administrative: "事務",
    training: "研修",
    unknown: "未確定",
  }[kind];
}

function recordKindEvidenceLabel(kind: ReconciliationKind): string {
  return {
    main: "本体申請を確認しました。",
    schedule_change: "日程変更申請を確認しました。",
    handoff: "引き継ぎ申請を確認しました。",
    handoff_five: "引き継ぎ5分申請を確認しました。",
    extra_thirty: "追加30分申請を確認しました。",
    administrative: "事務対応として確認しました。",
    training: "研修対応として確認しました。",
    unknown: "申請内容を確認しました。",
  }[kind];
}

function buildRuleEvidenceForRecord(
  kind: ReconciliationKind,
  source: "calendar" | "gmail",
  matched: GmailSubmissionRecord | null,
  attention: string,
): RuleEvidence[] {
  const evidence: RuleEvidence[] = [{
    code: `kind:${kind}`,
    source: "rule",
    detail: recordKindEvidenceLabel(kind),
  }];
  if (matched) {
    evidence.push({
      code: "matched-submission",
      source: "gmail",
      detail: `${matched.formLabel} の申請履歴を関連付けました。`,
    });
  }
  if (source === "gmail" && !matched) {
    evidence.push({
      code: "unmatched-submission",
      source: "gmail",
      detail: "申請履歴は見つかりましたが、対応する予定を特定できませんでした。",
    });
  }
  if (attention) {
    evidence.push({
      code: "attention",
      source: "rule",
      detail: attention,
    });
  }
  return evidence;
}

function inferAutofillPlan(
  record: ReconciliationRecord,
  config: AppConfig,
  plannedKind: ReconciliationKind = record.kind,
): { eligibility: ReconciliationRecord["autofillEligibility"]; reason: string; task?: AutofillTaskRecord } {
  const workflowSuggestion = record.workflowSuggestions?.find((item) => item.kind === plannedKind);
  const isDerivedWorkflow = Boolean(workflowSuggestion && plannedKind !== record.kind);
  const pendingStatus = deriveApplicationStatus(record.start);

  if (record.ignored) {
    return { eligibility: "not_applicable", reason: "無視中のため対象外です。" };
  }
  if (isLegacyHandoffYear(record.start) && (plannedKind === "handoff" || plannedKind === "handoff_five")) {
    return { eligibility: "not_applicable", reason: "2026年2月以前は引き継ぎ申請対象外です。" };
  }
  if (pendingStatus === "upcoming") {
    return { eligibility: "not_applicable", reason: "未来の予定は対象外です。" };
  }
  if (!isDerivedWorkflow && record.status !== "stale") {
    return { eligibility: "not_applicable", reason: "滞留のみ対象です。" };
  }

  const coachName = config.coachProfile.name;
  const coachCode = config.coachProfile.code;
  const coachEmail = config.coachProfile.email;
  if (!coachName || !coachCode || !coachEmail) {
    return { eligibility: "blocked", reason: "コーチ情報が不足しています。" };
  }

  let formType: GreenfieldFormType;
  let answers: Record<string, AnswerValue>;
  let reviewHints: string[] = [];
  let fieldSpecsOverride: TaskPayload["fieldSpecs"] | undefined;
  let handoffContentTitle = "";
  const coachNameForForm = formatFullNameForForm(coachName);

  if (plannedKind === "main") {
    formType = "work_report_coaching";
    const submission = record.submission;
    const studentNameForForm = formatFullNameForForm(record.studentName);
    answers = {
      メールアドレス: coachEmail,
      お名前_漢字フルネーム: coachNameForForm,
      コーチコード: coachCode,
      作業日時: inferDateFromIso(record.start),
      該当作業: "コーチング",
      生徒コード: record.resolvedStudentCode ?? submission?.studentCode ?? submission?.workReport?.studentCode ?? "",
      "生徒氏名(漢字フルネーム)": studentNameForForm,
      "コーチングの参加状況": submission?.workReport?.participationStatus ?? "当日参加",
      今日の振り返り: ["コーチング通知botへ今日の面談を実施する連絡をしましたか？"],
    };
    if (!answers["生徒コード"]) {
      reviewHints.push("生徒コードが不明です。");
    }
  } else if (plannedKind === "extra_thirty") {
    formType = "work_report_non_coaching";
    const durationMinutes = workflowSuggestion?.durationMinutes ?? 30;
    const durationHours = Math.floor(durationMinutes / 60);
    const durationRest = durationMinutes % 60;
    answers = {
      メールアドレス: coachEmail,
      お名前_漢字フルネーム: coachNameForForm,
      コーチコード: coachCode,
      作業日時: inferDateFromIso(record.start),
      該当作業: "コーチング以外",
      "コーチング以外の作業時間(時間:分)": `${durationHours}:${String(durationRest).padStart(2, "0")}`,
      作業内容: "その他",
      具体的な作業内容: workflowSuggestion?.reason.includes("小論文")
        ? `${record.studentName} 小論文・ティーチングの追加対応`
        : `${record.studentName} の追加対応`,
      業務依頼者: "齋藤 優真",
    };
  } else if (plannedKind === "schedule_change" && (record.submission?.scheduleChange || workflowSuggestion)) {
    formType = "schedule_change";
    const studentNameForForm = formatFullNameForForm(record.studentName);
    const schedule = record.submission?.scheduleChange ?? {
      originalDate: workflowSuggestion?.originalDate,
      originalTime: workflowSuggestion?.originalTime,
      targetDate: workflowSuggestion?.targetDate,
      targetTime: workflowSuggestion?.targetTime,
      reason: "生徒都合",
    };
    answers = {
      メールアドレス: coachEmail,
      お名前: coachNameForForm,
      "コーチング日程を変更する生徒さんのお名前を漢字で記入してください。\n※名字と名前の間に半角スペースを入れてください": studentNameForForm,
      "調整前(通常時)のコーチング時間を教えてください。": {
        date: schedule.originalDate ?? "",
        time: schedule.originalTime ?? "",
      },
      "変更後のコーチング時間を教えてください。": {
        date: schedule.targetDate ?? "",
        time: schedule.targetTime ?? "",
      },
      "コーチングの日程変更理由を教えてください。": schedule.reason || "生徒都合",
      "【予定が入ってしまったを選んだ方への質問です】\n予定を教えてください。": "",
      "【代行を依頼する場合】\n代行をしてくださるコーチのお名前をご記入ください。": "",
    };
  } else if (plannedKind === "handoff") {
    formType = "handoff";
    const policy = effectiveHandoffPolicy(record, workflowSuggestion);
    const studentNameForForm = formatFullNameForForm(record.studentName);
    const policyValue = policy === "advance_premium"
      ? "アドバンス/プレミアムコース（週2,3回）"
      : policy === "coach_change"
        ? "コーチ変更引き継ぎ"
        : policy === "substitute"
          ? "代行引き継ぎ"
          : "";
    const handoffContent = policy === "advance_premium"
      ? buildAdvancePremiumHandoffContent(record, coachName)
      : "通常通り実施しました。よろしくお願いいたします。";
    handoffContentTitle = handoffTextareaTitle(policy ?? "substitute");
    fieldSpecsOverride = handoffFieldSpecs(policy ?? "substitute");
    answers = {
      メールアドレス: coachEmail,
      お名前_漢字フルネーム: coachNameForForm,
      コーチコード: coachCode,
      "生徒氏名(漢字フルネーム)": studentNameForForm,
      生徒コード: record.resolvedStudentCode ?? record.submission?.studentCode ?? record.submission?.handoff?.studentCode ?? "",
      引き継ぎ項目: policyValue,
      [handoffContentTitle]: handoffContent,
    };
    if (!answers["生徒コード"] || !policyValue) {
      reviewHints.push("引き継ぎ種別または生徒コードの確認が必要です。");
    }
  } else if (plannedKind === "handoff_five") {
    formType = "work_report_non_coaching";
    answers = {
      メールアドレス: coachEmail,
      お名前_漢字フルネーム: coachNameForForm,
      コーチコード: coachCode,
      作業日時: inferDateFromIso(record.start),
      該当作業: "コーチング以外",
      "コーチング以外の作業時間(時間:分)": "0:05",
      作業内容: "(毎週)引き継ぎカルテ作成",
      具体的な作業内容: `${record.studentName} 引き継ぎ対応`,
      業務依頼者: "齋藤 優真",
    };
  } else {
    return { eligibility: "not_applicable", reason: "この種別は自動入力対象外です。" };
  }

  const fieldSpecs = fieldSpecsOverride ?? FORM_CATALOG[formType].fieldSpecs;
  const missingFields = requiredMissingFields(fieldSpecs, answers);
  const task: AutofillTaskRecord = {
    id: `aft-${createHash("sha1").update(`${record.id}:${plannedKind}`).digest("hex").slice(0, 12)}`,
    reconciliationId: record.id,
    plannedKind,
    formKey: FORM_CATALOG[formType].formKey,
    formType,
    launchUrl: `${FORM_CATALOG[formType].viewUrl}#gc-task=${encodeURIComponent(`aft-${createHash("sha1").update(`${record.id}:${plannedKind}`).digest("hex").slice(0, 12)}`)}`,
    status: missingFields.length > 0 || reviewHints.length > 0 ? "autofill_blocked" : "autofill_ready",
    payload: buildPayload(fieldSpecs, answers, reviewHints),
    missingFields,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    lastError: null,
  };

  if (task.status === "autofill_ready") {
    return { eligibility: "ready", reason: "", task };
  }
  return {
    eligibility: "blocked",
    reason: dedupeAutofillReason(missingFields, reviewHints) || "自動入力に必要な情報が不足しています。",
    task,
  };
}

function bundleItemLabel(kind: ReconciliationKind): string {
  return {
    main: "本体申請",
    schedule_change: "日程変更",
    handoff: "引き継ぎ",
    handoff_five: "引き継ぎ5分",
    extra_thirty: "追加30分",
    administrative: "事務",
    training: "研修",
    unknown: "未確定",
  }[kind];
}

function plannedKindsForRecord(record: ReconciliationRecord): ReconciliationKind[] {
  const ordered: ReconciliationKind[] = [];
  if (
    record.source === "calendar"
    && !record.ignored
    && looksLikeStudentEntity(record.studentName)
    && record.kind === "main"
    && record.submissionIds.length === 0
    && ["stale", "review"].includes(record.status)
  ) {
    ordered.push("main");
  }
  for (const suggestion of record.workflowSuggestions ?? []) {
    ordered.push(suggestion.kind);
  }
  return ordered
    .filter((kind, index, array) => array.indexOf(kind) === index)
    .filter((kind) => !isLegacyHandoffYear(record.start) || (kind !== "handoff" && kind !== "handoff_five"));
}

function previewLinesForTask(task: AutofillTaskRecord): string[] {
  const answers = task.payload.answers;
  if (task.formType === "work_report_coaching") {
    return [
      `作業日: ${String(answers["作業日時"] || "")}`,
      `生徒コード: ${String(answers["生徒コード"] || "未設定")}`,
      `参加状況: ${String(answers["コーチングの参加状況"] || "未設定")}`,
    ];
  }
  if (task.formType === "work_report_non_coaching") {
    return [
      `作業日: ${String(answers["作業日時"] || "")}`,
      `作業時間: ${String(answers["コーチング以外の作業時間(時間:分)"] || "未設定")}`,
      `内容: ${String(answers["作業内容"] || answers["具体的な作業内容"] || "未設定")}`,
    ];
  }
  if (task.formType === "schedule_change") {
    const original = answers["調整前(通常時)のコーチング時間を教えてください。"] as { date?: string; time?: string } | undefined;
    const target = answers["変更後のコーチング時間を教えてください。"] as { date?: string; time?: string } | undefined;
    return [
      `調整前: ${[original?.date, original?.time].filter(Boolean).join(" ") || "未設定"}`,
      `変更後: ${[target?.date, target?.time].filter(Boolean).join(" ") || "未設定"}`,
      `理由: ${String(answers["コーチングの日程変更理由を教えてください。"] || "未設定")}`,
    ];
  }
  if (task.formType === "handoff") {
    const contentTitle = Object.keys(answers).find((title) => title.endsWith("_引き継ぎ内容")) || "引き継ぎ内容";
    return [
      `生徒コード: ${String(answers["生徒コード"] || "未設定")}`,
      `引き継ぎ種別: ${String(answers["引き継ぎ項目"] || "未設定")}`,
      `内容: ${String(answers[contentTitle] || "未設定")}`,
    ];
  }
  return [];
}

function previewLinesForSubmission(submission: GmailSubmissionRecord): string[] {
  const kind = submissionKind(submission);
  if (kind === "main") {
    return [
      `作業日: ${String(submission.sessionDate || "")}`,
      `生徒コード: ${String(submission.studentCode || submission.workReport?.studentCode || "未設定")}`,
      `参加状況: ${String(submission.workReport?.participationStatus || "未設定")}`,
    ];
  }
  if (kind === "extra_thirty" || kind === "handoff_five") {
    return [
      `作業日: ${String(submission.sessionDate || "")}`,
      `内容: ${String(submission.workReport?.taskLabel || "未設定")}`,
      `詳細: ${String(submission.workReport?.detailedTask || "未設定")}`,
    ];
  }
  if (kind === "schedule_change") {
    return [
      `調整前: ${[submission.scheduleChange?.originalDate, submission.scheduleChange?.originalTime].filter(Boolean).join(" ") || "未設定"}`,
      `変更後: ${[submission.scheduleChange?.targetDate, submission.scheduleChange?.targetTime].filter(Boolean).join(" ") || "未設定"}`,
      `理由: ${String(submission.scheduleChange?.reason || "未設定")}`,
    ];
  }
  if (kind === "handoff") {
    const policyLabel = submission.handoff?.policy === "advance_premium"
      ? "アドバンス/プレミアムコース（週2,3回）"
      : submission.handoff?.policy === "coach_change"
        ? "コーチ変更引き継ぎ"
        : submission.handoff?.policy === "substitute"
          ? "代行引き継ぎ"
          : "未設定";
    return [
      `生徒コード: ${String(submission.studentCode || submission.handoff?.studentCode || "未設定")}`,
      `引き継ぎ種別: ${policyLabel}`,
      `送信日時: ${[inferDateFromIso(submission.submittedAt), inferTimeFromIso(submission.submittedAt)].filter(Boolean).join(" ")}`,
    ];
  }
  return [];
}

function inferHandoffTargetDate(
  submission: GmailSubmissionRecord,
  submissions: GmailSubmissionRecord[],
): string | null {
  const nearbySessionReports = submissions
    .filter((candidate) => candidate.id !== submission.id)
    .filter((candidate) => submissionTargetsStudent(candidate, submission.studentName || ""))
    .filter((candidate) => candidate.formKey === "work_report")
    .filter((candidate) => Boolean(candidate.sessionDate))
    .map((candidate) => ({
      submission: candidate,
      deltaMs: Math.abs(new Date(candidate.submittedAt).getTime() - new Date(submission.submittedAt).getTime()),
    }))
    .filter((candidate) => candidate.deltaMs <= 30 * 60 * 1000)
    .sort((left, right) => left.deltaMs - right.deltaMs || right.submission.submittedAt.localeCompare(left.submission.submittedAt));

  return nearbySessionReports[0]?.submission.sessionDate ?? null;
}

function buildSupplementalSubmissionAssignments(
  events: Array<{
    id: string;
    title: string;
    start: string;
  }>,
  submissions: GmailSubmissionRecord[],
): Map<string, GmailSubmissionRecord[]> {
  const assignments = new Map<string, GmailSubmissionRecord[]>();
  const pushAssignment = (recordId: string, submission: GmailSubmissionRecord) => {
    const current = assignments.get(recordId) ?? [];
    if (current.some((item) => item.id === submission.id)) {
      return;
    }
    assignments.set(recordId, [...current, submission]);
  };

  const supplementalReports = submissions
    .filter((submission) => {
      const kind = submissionKind(submission);
      return kind === "extra_thirty" || kind === "handoff_five";
    })
    .sort((left, right) => right.submittedAt.localeCompare(left.submittedAt));

  for (const submission of supplementalReports) {
    const candidates = events
      .filter((event) => submissionTargetsStudent(submission, normalizeStudentName(event.title)))
      .map((event) => ({
        event,
        delta: Math.abs(diffDays(event.start.slice(0, 10), submissionDateForMatch(submission))),
      }))
      .filter((candidate) => candidate.delta <= 1)
      .sort((left, right) => left.delta - right.delta || right.event.start.localeCompare(left.event.start));
    const target = candidates[0]?.event;
    if (target) {
      pushAssignment(`rec:${target.id}`, submission);
    }
  }

  const handoffForms = submissions
    .filter((submission) => submission.formKey === "handoff")
    .sort((left, right) => right.submittedAt.localeCompare(left.submittedAt));

  for (const submission of handoffForms) {
    const inferredDate = inferHandoffTargetDate(submission, submissions);
    const submittedDay = submission.submittedAt.slice(0, 10);
    const candidates = events
      .filter((event) => !isLegacyHandoffYear(event.start))
      .filter((event) => submissionTargetsStudent(submission, normalizeStudentName(event.title)))
      .map((event) => {
        const eventDate = event.start.slice(0, 10);
        const dayDelta = diffDays(eventDate, submittedDay);
        return {
          event,
          exactInferredDate: inferredDate ? eventDate === inferredDate : false,
          futurePenalty: dayDelta > 0 ? 1 : 0,
          absoluteDelta: Math.abs(dayDelta),
        };
      })
      .filter((candidate) => candidate.exactInferredDate || candidate.absoluteDelta <= 14)
      .sort((left, right) =>
        Number(right.exactInferredDate) - Number(left.exactInferredDate)
        || left.futurePenalty - right.futurePenalty
        || left.absoluteDelta - right.absoluteDelta
        || right.event.start.localeCompare(left.event.start),
      );
    const target = candidates[0]?.event;
    if (target) {
      pushAssignment(`rec:${target.id}`, submission);
    }
  }

  return assignments;
}

function buildApplicationFormItems(
  record: ReconciliationRecord,
  submissions: GmailSubmissionRecord[],
  assignedSubmissions: GmailSubmissionRecord[],
  runtimeState: ReturnType<typeof loadRuntimeState>,
  config: AppConfig,
): ApplicationFormItem[] {
  const items: ApplicationFormItem[] = [];
  const seenKinds = new Set<ReconciliationKind>();
  const pushItem = (item: ApplicationFormItem | null) => {
    if (!item || seenKinds.has(item.kind)) {
      return;
    }
    seenKinds.add(item.kind);
    items.push(item);
  };
  const runtimeTasks = Object.values(runtimeState.autofillTasks).filter((task) => task.reconciliationId === record.id);
  const hasPendingRuntimeTask = runtimeTasks.some((task) => isPendingWorkflowTask(task));
  const taskByKind = new Map<ReconciliationKind, AutofillTaskRecord>();
  for (const task of runtimeTasks) {
    const kind = (task.plannedKind ?? record.kind) as ReconciliationKind;
    if (!taskByKind.has(kind)) {
      taskByKind.set(kind, task);
    }
  }
  const submissionByKind = new Map<ReconciliationKind, GmailSubmissionRecord>();
  for (const submission of [...(record.submission ? [record.submission, ...assignedSubmissions] : assignedSubmissions)].sort((left, right) =>
    right.submittedAt.localeCompare(left.submittedAt),
  )) {
    const kind = submissionKind(submission);
    if (!submissionByKind.has(kind)) {
      submissionByKind.set(kind, submission);
    }
  }

  const candidateKinds = new Set<ReconciliationKind>();
  if (record.source === "calendar" && record.kind === "main" && looksLikeStudentEntity(record.studentName)) {
    candidateKinds.add("main");
  } else {
    candidateKinds.add(record.kind);
  }
  for (const item of record.autofillBundle ?? []) {
    candidateKinds.add(item.kind);
  }
  for (const suggestion of record.workflowSuggestions ?? []) {
    candidateKinds.add(suggestion.kind);
  }
  for (const task of runtimeTasks) {
    candidateKinds.add((task.plannedKind ?? record.kind) as ReconciliationKind);
  }
  for (const kind of submissionByKind.keys()) {
    candidateKinds.add(kind);
  }
  if (record.kind === "main" && record.source === "calendar" && record.completionState === "partial") {
    for (const kind of eventMissingRequirements(record, submissions, record.studentRoutineProfile?.expectedKinds)) {
      candidateKinds.add(kind);
    }
  }

  const bundleByKind = new Map((record.autofillBundle ?? []).map((item) => [item.kind, item] as const));
  const orderedKinds: ReconciliationKind[] = ["main", "schedule_change", "handoff", "handoff_five", "extra_thirty"];

  for (const kind of orderedKinds) {
    if (!candidateKinds.has(kind)) {
      continue;
    }
    const matchedSubmission = submissionByKind.get(kind);
    if (matchedSubmission) {
      pushItem({
        id: `${record.id}:form:${kind}:submitted`,
        kind,
        label: bundleItemLabel(kind),
        status: "submitted",
        previewLines: previewLinesForSubmission(matchedSubmission),
        autofillReason: "",
        submittedAt: matchedSubmission.submittedAt,
      });
      continue;
    }

    const bundleItem = bundleByKind.get(kind);
    if (bundleItem) {
      pushItem({
        id: bundleItem.id,
        kind,
        label: bundleItem.label,
        status: normalizeWorkflowDisplayStatus(bundleItem.task?.status)
          ?? (bundleItem.eligibility === "ready" ? "autofill_ready" : bundleItem.eligibility === "blocked" ? "autofill_blocked" : "not_applicable"),
        previewLines: bundleItem.previewLines,
        autofillReason: bundleItem.autofillReason,
      });
      continue;
    }

    const existingTask = taskByKind.get(kind) ?? null;
    if (existingTask && isPendingWorkflowTask(existingTask)) {
      pushItem({
        id: `${record.id}:form:${kind}:pending-task`,
        kind,
        label: bundleItemLabel(kind),
        status: normalizeWorkflowDisplayStatus(existingTask.status) ?? existingTask.status,
        previewLines: previewLinesForTask(existingTask),
        autofillReason: reasonForAutofillTaskStatus(existingTask, ""),
      });
      continue;
    }
    if (existingTask && hasPendingRuntimeTask) {
      pushItem({
        id: `${record.id}:form:${kind}:task-review`,
        kind,
        label: bundleItemLabel(kind),
        status: "autofill_blocked",
        previewLines: previewLinesForTask(existingTask),
        autofillReason: "回答メールはまだ確認できていません。送信できたか確認してください。",
      });
      continue;
    }
    const plan = inferAutofillPlan(record, config, kind);
    const mergedTask = mergePlannedTask(
      plan.task ?? undefined,
      existingTask,
      plan.eligibility === "ready" ? "autofill_ready" : "autofill_blocked",
    );

    if (mergedTask) {
      pushItem({
        id: `${record.id}:form:${kind}:task`,
        kind,
        label: bundleItemLabel(kind),
        status: normalizeWorkflowDisplayStatus(mergedTask.status) ?? mergedTask.status,
        previewLines: previewLinesForTask(mergedTask),
        autofillReason: reasonForAutofillTaskStatus(mergedTask, plan.reason),
      });
      continue;
    }

    if (plan.eligibility !== "not_applicable" || (kind === "main" && record.source === "calendar")) {
      const displayReason = kind === "main" && record.source === "calendar" && plan.reason === "滞留のみ対象です。"
        ? "申請の確認が必要です。"
        : plan.reason;
      pushItem({
        id: `${record.id}:form:${kind}:planned`,
        kind,
        label: bundleItemLabel(kind),
        status: plan.eligibility === "ready" ? "autofill_ready" : "autofill_blocked",
        previewLines: plan.task ? previewLinesForTask(plan.task) : [],
        autofillReason: displayReason,
      });
    }
  }

  return items;
}

function mergePlannedTask(
  plannedTask: AutofillTaskRecord | undefined,
  existingTask: AutofillTaskRecord | null,
  fallbackStatus: AutofillTaskRecord["status"],
): AutofillTaskRecord | null {
  if (!plannedTask) {
    if (
      existingTask?.status === "awaiting_user_submit"
      || existingTask?.status === "submitted_confirmed"
    ) {
      return null;
    }
    return existingTask;
  }
  const nextStatus = existingTask?.status === "awaiting_user_submit"
    || existingTask?.status === "autofill_running"
    || existingTask?.status === "submitted_confirmed"
    || existingTask?.status === "error"
    ? existingTask.status
    : fallbackStatus;
  return {
    ...plannedTask,
    status: nextStatus,
    createdAt: existingTask?.createdAt ?? plannedTask.createdAt,
    updatedAt: existingTask?.updatedAt ?? plannedTask.updatedAt,
    lastError: nextStatus === "error"
      ? existingTask?.lastError ?? plannedTask.lastError ?? null
      : plannedTask.lastError ?? null,
    missingFields: plannedTask.missingFields,
  };
}

function isPendingWorkflowTask(task: AutofillTaskRecord | null | undefined): boolean {
  return task?.status === "autofill_running"
    || task?.status === "awaiting_user_submit"
    || task?.status === "submitted_confirmed";
}

function pendingWorkflowStatusForBundle(items: AutofillBundleItem[]): "awaiting_user_submit" | null {
  if (items.some((item) => item.task?.status === "awaiting_user_submit" || item.task?.status === "submitted_confirmed" || item.task?.status === "autofill_running")) {
    return "awaiting_user_submit";
  }
  return null;
}

function buildAutofillBundle(record: ReconciliationRecord, config: AppConfig): AutofillBundleItem[] {
  return plannedKindsForRecord(record).map((kind) => {
    const suggestion = record.workflowSuggestions?.find((item) => item.kind === kind);
    const plan = inferAutofillPlan(record, config, kind);
    const task = plan.task ?? null;
    return {
      id: `${record.id}:${kind}`,
      kind,
      label: suggestion?.label ?? bundleItemLabel(kind),
      reason: suggestion?.reason ?? plan.reason,
      eligibility: plan.eligibility,
      previewLines: task ? previewLinesForTask(task) : (suggestion?.preview ? [suggestion.preview] : []),
      autofillReason: plan.reason,
      task,
    };
  });
}

function applyRecordOverride(record: ReconciliationRecord, override: ReconciliationOverrideRecord | undefined): ReconciliationRecord {
  if (!override) {
    return record;
  }
  const next = {
    ...record,
    studentName: override.studentName ? displayStudentName(override.studentName) : record.studentName,
    studentKey: override.studentName ? normalizeName(override.studentName) : record.studentKey,
    kind: override.kind ?? record.kind,
    ignored: Boolean(override.ignored),
    status: override.ignored ? "ignored" as const : record.status,
    ruleEvidence: [
      ...record.ruleEvidence,
      ...(override.studentName || override.kind || override.ignored
        ? [{
            code: "override",
            source: "override" as const,
            detail: `手動補正を適用しました。${override.note ? ` ${override.note}` : ""}`.trim(),
          }]
        : []),
    ],
  };
  return next;
}

function buildWorkspaceSummary(
  events: Array<{
    id: string;
    title: string;
    start: string;
    end?: string;
    url?: string;
    extendedProps?: {
      accountEmail?: string;
      calendarId?: string;
      accountId?: string;
      googleCalendarId?: string;
      googleEventId?: string;
      location?: string;
      description?: string;
    };
  }>,
  submissions: GmailSubmissionRecord[],
  runtimeState: ReturnType<typeof loadRuntimeState>,
  config: AppConfig,
) {
  const invalidatedSubmissionIds = new Set(runtimeState.invalidatedSubmissionIds);
  const activeSubmissions = submissions.filter((submission) => !invalidatedSubmissionIds.has(submission.id));
  const supplementalSubmissionAssignments = buildSupplementalSubmissionAssignments(events, activeSubmissions);
  const studentCodeDirectory = inferStudentCodeDirectory(activeSubmissions, runtimeState);
  const unmatchedSubmissionIds = new Set(activeSubmissions.map((submission) => submission.id));

  const applications: ReconciliationRecord[] = events.map((event) => {
    const studentName = displayStudentName(normalizeStudentName(event.title));
    const studentKey = normalizeName(studentName);
    const directoryEntry = resolveStudentCodeDirectoryEntry(studentCodeDirectory, studentKey, studentName);
    const ranked = activeSubmissions
      .filter((submission) => unmatchedSubmissionIds.has(submission.id))
      .map((submission) => ({
        submission,
        score: scoreSubmissionMatch(event, submission),
      }))
      .filter((candidate) => candidate.score >= 10)
      .sort((left, right) => right.score - left.score || right.submission.submittedAt.localeCompare(left.submission.submittedAt));

    const matched = ranked[0]?.submission ?? null;
    if (matched) {
      unmatchedSubmissionIds.delete(matched.id);
    }

    const pendingStatus = deriveApplicationStatus(event.start);
    const completionState = eventDisplayState(event, activeSubmissions);
    const kind = determineRecordKindFromEvent(event, matched);
    const status = matched
      ? "submitted"
      : completionState === "partial"
        ? pendingStatus === "stale" ? "stale" : "review"
        : pendingStatus;
    const missingRequirements = completionState === "partial"
      ? eventMissingRequirements(event, activeSubmissions)
      : [];
    const attention = completionState === "partial"
      ? missingRequirementsAttention(missingRequirements)
      : matched
        ? ""
        : attentionReason(pendingStatus, event.start);
    return {
      id: `rec:${event.id}`,
      title: event.title,
      studentName,
      studentKey,
      start: event.start,
      end: event.end,
      url: event.url,
      status,
      kind,
      source: "calendar",
      completionState,
      formLabel: matched?.formLabel ?? "",
      attentionReason: attention,
      ignored: false,
      accountEmail: event.extendedProps?.accountEmail ?? "",
      location: event.extendedProps?.location ?? "",
      sessionIds: [event.id],
      submissionIds: matched ? [matched.id] : [],
      relatedSources: [
        sourceSnapshotFromEvent(event),
        ...(matched ? [sourceSnapshotFromSubmission(matched)] : []),
      ],
      calendarEvent: {
        id: event.id,
        accountId: event.extendedProps?.accountId ?? "",
        googleCalendarId: event.extendedProps?.googleCalendarId ?? "",
        googleEventId: event.extendedProps?.googleEventId ?? "",
        title: event.title,
      },
      ruleEvidence: buildRuleEvidenceForRecord(kind, "calendar", matched, attention),
      autofillEligibility: "not_applicable",
      autofillReason: "未評価",
      autofillTask: null,
      resolvedStudentCode: matched?.studentCode ?? matched?.workReport?.studentCode ?? matched?.handoff?.studentCode ?? directoryEntry?.studentCode,
      studentCodeCandidate: directoryEntry
        ? {
            studentCode: directoryEntry.studentCode,
            confidence: directoryEntry.confidence,
            evidenceCount: directoryEntry.evidenceCount,
            source: "directory",
          }
        : undefined,
      calendarSuggestions: [],
      workflowSuggestions: [],
      submission: matched ?? undefined,
    };
  });

  for (const submission of activeSubmissions) {
    if (!unmatchedSubmissionIds.has(submission.id)) {
      continue;
    }
    if (isAdministrativeWorkReport(submission)) {
      continue;
    }
    if (isGenericHandoffSubmission(submission)) {
      continue;
    }
    if (hasResolvableEventForSubmission(submission, events, activeSubmissions)) {
      continue;
    }
    const derivedStart = derivedSubmissionStart(submission);
    const kind = submissionKind(submission);
    if (kind === "administrative" || kind === "training" || kind === "unknown") {
      continue;
    }
    const attention = submissionReviewReason(submission, events);
    const submissionName = displayStudentName(submission.studentName);
    const submissionKey = normalizeName(submissionName);
    const directoryEntry = resolveStudentCodeDirectoryEntry(studentCodeDirectory, submissionKey, submissionName);
    applications.push({
      id: `rec:submission:${submission.id}`,
      title: submission.formKey === "schedule_change" ? buildScheduleChangeTitle(submission) : submission.formLabel,
      studentName: submissionName,
      studentKey: submissionKey,
      start: derivedStart,
      end: undefined,
      url: undefined,
      status: deriveApplicationStatus(derivedStart) === "stale" ? "stale" : "review",
      kind,
      source: "gmail",
      completionState: "partial",
      formLabel: submission.formLabel,
      attentionReason: attention,
      ignored: false,
      accountEmail: submission.accountEmail,
      location: "",
      sessionIds: [],
      submissionIds: [submission.id],
      relatedSources: [sourceSnapshotFromSubmission(submission)],
      calendarEvent: undefined,
      ruleEvidence: buildRuleEvidenceForRecord(kind, "gmail", null, attention),
      autofillEligibility: "not_applicable",
      autofillReason: "未評価",
      autofillTask: null,
      resolvedStudentCode: submission.studentCode ?? submission.workReport?.studentCode ?? submission.handoff?.studentCode ?? directoryEntry?.studentCode,
      studentCodeCandidate: directoryEntry
        ? {
            studentCode: directoryEntry.studentCode,
            confidence: directoryEntry.confidence,
            evidenceCount: directoryEntry.evidenceCount,
            source: "directory",
          }
        : undefined,
      calendarSuggestions: [],
      workflowSuggestions: [],
      submission,
    });
  }

  const recordsWithOverrides = applications
    .map((record) => applyRecordOverride(record, runtimeState.reconciliationOverrides[record.id]));

  const applicationsWithOverrides = recordsWithOverrides
    .map((record) => {
      const directoryEntry = resolveStudentCodeDirectoryEntry(studentCodeDirectory, record.studentKey, record.studentName);
      const resolvedStudentCode = record.resolvedStudentCode || directoryEntry?.studentCode;
      const studentCodeCandidate = directoryEntry?.source === "inferred"
        ? {
            studentCode: directoryEntry.studentCode,
            confidence: directoryEntry.confidence,
            evidenceCount: directoryEntry.evidenceCount,
            source: "history" as const,
          }
        : record.studentCodeCandidate;
      const routineProfileEntry = resolveStudentRoutineProfileEntry(
        runtimeState.studentRoutineProfiles,
        record.studentKey,
        record.studentName,
      );
      const studentRoutineProfile = inferStudentRoutineProfile(
        record.studentKey,
        record.studentName,
        recordsWithOverrides.filter((candidate) =>
          candidate.studentKey === record.studentKey || isLikelySameStudent(candidate.studentName, record.studentName),
        ),
        routineProfileEntry,
      );
      const recomputedCompletionState = record.source === "calendar"
        ? eventDisplayState(
            {
              title: record.title,
              start: record.start,
              extendedProps: {
                description: record.location,
              },
            },
            activeSubmissions,
            studentRoutineProfile.expectedKinds,
          )
        : record.completionState;
      const recomputedMissingRequirements = record.source === "calendar" && recomputedCompletionState === "partial"
        ? eventMissingRequirements(
            {
              title: record.title,
              start: record.start,
              extendedProps: {
                description: record.location,
              },
            },
            activeSubmissions,
            studentRoutineProfile.expectedKinds,
          )
        : [];
      const workflowSuggestions = mergeWorkflowSuggestions(
        inferWorkflowSuggestions({
          ...record,
          resolvedStudentCode,
          studentCodeCandidate,
          studentRoutineProfile,
        }, events),
        recomputedMissingRequirements
          .map((kind) => missingRequirementWorkflowSuggestion(kind, {
            ...record,
            resolvedStudentCode,
            studentCodeCandidate,
            studentRoutineProfile,
          }))
          .filter((item): item is WorkflowAutofillSuggestion => item !== null),
      );
      const calendarSuggestions = [
        ...findScheduleChangeSuggestion(record, events),
        ...findUnmatchedMainSuggestion(record, events),
      ];
      const derivedPendingStatus = deriveApplicationStatus(record.start);
      const isUpcomingRecord = derivedPendingStatus === "upcoming";
      const existingTask = isUpcomingRecord
        ? null
        : Object.values(runtimeState.autofillTasks).find((task) =>
            task.reconciliationId === record.id && (task.plannedKind ?? record.kind) === record.kind,
          ) ?? null;
      const plan = inferAutofillPlan({
        ...record,
        resolvedStudentCode,
        studentCodeCandidate,
        calendarSuggestions,
        workflowSuggestions,
        studentRoutineProfile,
      }, config, record.kind);
      const rawBundle = buildAutofillBundle({
        ...record,
        resolvedStudentCode,
        studentCodeCandidate,
        calendarSuggestions,
        workflowSuggestions,
        studentRoutineProfile,
      }, config);
      const missingWorkflowKinds = new Set<"handoff" | "handoff_five" | "extra_thirty">(recomputedMissingRequirements);
      const autofillBundle = rawBundle
        .filter((item) =>
          (item.kind === "handoff" || item.kind === "handoff_five" || item.kind === "extra_thirty")
          && missingWorkflowKinds.has(item.kind),
        )
        .map((item) => {
          const existing = isUpcomingRecord
            ? null
            : Object.values(runtimeState.autofillTasks).find((task) =>
                task.reconciliationId === record.id && (task.plannedKind ?? record.kind) === item.kind,
              ) ?? null;
          const mergedTask = mergePlannedTask(
            item.task ?? undefined,
            existing,
            item.eligibility === "ready" ? "autofill_ready" : "autofill_blocked",
          );
          const eligibility = isUpcomingRecord
            ? "not_applicable"
            : mergedTask?.status === "autofill_blocked"
              ? "blocked"
              : mergedTask?.status === "autofill_ready" || mergedTask?.status === "awaiting_user_submit" || mergedTask?.status === "autofill_running"
                ? "ready"
                : item.eligibility;
          return {
            ...item,
            eligibility,
            autofillReason: isUpcomingRecord ? "未来の予定は対象外です。" : reasonForAutofillTaskStatus(mergedTask, item.autofillReason),
            task: isUpcomingRecord ? null : mergedTask,
          };
        });
      const hasReadyBundleItems = autofillBundle.some((item) =>
        item.eligibility === "ready" && !isPendingWorkflowTask(item.task),
      );
      const pendingBundleStatus = pendingWorkflowStatusForBundle(autofillBundle);
      const pendingBundleKinds = new Set(
        autofillBundle
          .filter((item) => isPendingWorkflowTask(item.task))
          .map((item) => item.kind)
          .filter((kind): kind is "handoff" | "handoff_five" | "extra_thirty" =>
            kind === "handoff" || kind === "handoff_five" || kind === "extra_thirty",
          ),
      );
      const task = isUpcomingRecord
        ? null
        : mergePlannedTask(
            plan.task ?? undefined,
            existingTask,
            plan.eligibility === "ready" ? "autofill_ready" : "autofill_blocked",
          );
      const effectiveMissingRequirements = recomputedMissingRequirements.filter((kind) => !pendingBundleKinds.has(kind));
      const effectiveCompletionState = record.source === "calendar" && recomputedCompletionState === "partial" && effectiveMissingRequirements.length === 0
        ? "complete"
        : recomputedCompletionState;
      const recomputedAttentionReason = hasReadyBundleItems && autofillBundle.some((item) => isPendingWorkflowTask(item.task))
        ? "必要な追加申請の一部は要確認ですが、未送信の申請が残っています。残りを送信してください。"
        : pendingBundleStatus
          ? "必要な追加申請は要確認です。回答メールで確認できるまでこの案件を保留します。"
        : record.source === "calendar" && effectiveCompletionState === "partial"
          ? missingRequirementsAttention(effectiveMissingRequirements)
        : record.attentionReason;
      const status = record.ignored
        ? "ignored"
        : isUpcomingRecord
          ? "upcoming"
          : pendingBundleStatus === "awaiting_user_submit"
            ? "awaiting_user_submit"
          : task?.status === "submitted_confirmed" || task?.status === "awaiting_user_submit" || task?.status === "autofill_running"
            ? "awaiting_user_submit"
            : record.source === "calendar" && effectiveCompletionState === "partial"
              ? (derivedPendingStatus === "stale" ? "stale" : "review")
              : record.status;
      const applicationForms = buildApplicationFormItems({
        ...record,
        completionState: effectiveCompletionState,
        status,
        attentionReason: recomputedAttentionReason,
        workflowSuggestions,
        autofillBundle,
        autofillTask: task,
      }, activeSubmissions, supplementalSubmissionAssignments.get(record.id) ?? [], runtimeState, config);
      return {
        ...record,
        completionState: effectiveCompletionState,
        resolvedStudentCode,
        studentCodeCandidate,
        studentRoutineProfile,
        calendarSuggestions,
        workflowSuggestions,
        autofillBundle,
        applicationForms,
        status,
        attentionReason: recomputedAttentionReason,
        autofillEligibility: isUpcomingRecord
          ? "not_applicable"
          : task
            ? task.status === "autofill_blocked"
              ? "blocked"
              : task.status === "autofill_ready" || task.status === "awaiting_user_submit" || task.status === "autofill_running"
                ? "ready"
                : record.autofillEligibility
            : plan.eligibility,
        autofillReason: isUpcomingRecord ? "未来の予定は対象外です。" : reasonForAutofillTaskStatus(task, plan.reason),
        autofillTask: isUpcomingRecord ? null : task,
      };
    })
    .sort((left, right) => right.start.localeCompare(left.start));

  const studentsByName = new Map<string, {
    id: string;
    name: string;
    sessions: ReconciliationRecord[];
  }>();

  applicationsWithOverrides.forEach((application) => {
    if (application.ignored) {
      return;
    }
    const exactKey = application.studentKey || normalizeName(application.studentName);
    const aliasKey = Array.from(studentsByName.entries()).find(([, student]) =>
      isLikelySameStudent(student.name, application.studentName),
    )?.[0];
    const key = aliasKey ?? exactKey;
    const current = studentsByName.get(key) ?? { id: key, name: application.studentName, sessions: [] };
    if (current.name === "未特定" && application.studentName !== "未特定") {
      current.name = application.studentName;
    }
    current.sessions.push(application);
    studentsByName.set(key, current);
  });

  const manualStudentSeeds = new Map<string, { id: string; name: string }>();
  for (const [studentKey, profile] of Object.entries(runtimeState.studentRoutineProfiles)) {
    manualStudentSeeds.set(studentKey, {
      id: studentKey,
      name: profile.studentName || studentKey,
    });
  }
  for (const [studentKey, directoryEntry] of Object.entries(studentCodeDirectory)) {
    if (!manualStudentSeeds.has(studentKey)) {
      manualStudentSeeds.set(studentKey, {
        id: studentKey,
        name: directoryEntry.studentName || studentKey,
      });
    }
  }
  for (const seed of manualStudentSeeds.values()) {
    const aliasKey = Array.from(studentsByName.entries()).find(([, student]) =>
      isLikelySameStudent(student.name, seed.name),
    )?.[0];
    const key = aliasKey ?? seed.id;
    if (!studentsByName.has(key)) {
      studentsByName.set(key, {
        id: key,
        name: seed.name,
        sessions: [],
      });
    }
  }

  const students = Array.from(studentsByName.values()).map((student) => {
    const upcoming = student.sessions.filter((item) => item.status === "upcoming");
    const pending = student.sessions.filter((item) => ["draft", "review", "stale", "autofill_ready", "autofill_blocked", "awaiting_user_submit"].includes(item.status));
    const submitted = student.sessions.filter((item) => item.status === "submitted");
    const nextSession = [...upcoming].sort((a, b) => a.start.localeCompare(b.start))[0] ?? null;
    const routineProfile = student.sessions[0]?.studentRoutineProfile ?? inferStudentRoutineProfile(student.id, student.name, student.sessions);
    return {
      id: student.id,
      name: student.name,
      sessions: student.sessions,
      upcomingCount: upcoming.length,
      pendingCount: pending.length,
      submittedCount: submitted.length,
      nextSession,
      routineProfile,
    };
  }).sort((left, right) => left.name.localeCompare(right.name, "ja"));

  return { students, applications: applicationsWithOverrides };
}

async function buildAccountStatuses(config: AppConfig): Promise<{
  gmailAccounts: GoogleAccountStatus[];
  calendarAccounts: GoogleAccountStatus[];
}> {
  const gmailAccounts = await Promise.all(
    config.googleAccounts.gmails.map(async (account) => ({
      id: account.id,
      email: await fetchGoogleAccountEmail(config, account),
      connected: Boolean(loadSavedTokens(account.tokenPath)),
    })),
  );
  const calendarAccounts = await Promise.all(
    config.googleAccounts.calendars.map(async (account) => ({
      id: account.id,
      email: await fetchGoogleAccountEmail(config, account),
      connected: Boolean(loadSavedTokens(account.tokenPath)),
    })),
  );

  return { gmailAccounts, calendarAccounts };
}

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/api/me", (request, response) => {
  const user = getRequestUser(request);
  response.json({ user: user ?? null });
});

app.post("/api/auth/google/start", (_request, response) => {
  try {
    const state = randomUUID();
    oauthRequests.set(state, {
      status: "pending",
      purpose: "login",
      updatedAt: Date.now(),
    });
    response.json({
      state,
      authorizationUrl: buildGoogleAuthUrl(DEFAULT_CONFIG, "login", state),
    });
  } catch (error) {
    respondError(response, error, 400);
  }
});

app.post("/api/auth/logout", (_request, response) => {
  clearSessionCookie(response);
  response.json({ ok: true });
});

app.get("/api/config", (request, response) => {
  const user = getRequestUser(request);
  if (!user) {
    respondError(response, new Error("Authentication required"), 401);
    return;
  }
  response.json({
    config: loadConfig(user.id),
    defaults: DEFAULT_CONFIG,
  });
});

app.post("/api/config", (request, response) => {
  try {
    const user = getRequestUser(request);
    if (!user) {
      respondError(response, new Error("Authentication required"), 401);
      return;
    }
    const current = loadConfig(user.id);
    const next = mergeConfig(current, {
      coachProfile: {
        name: typeof request.body?.coachProfile?.name === "string"
          ? request.body.coachProfile.name
          : current.coachProfile.name,
        code: typeof request.body?.coachProfile?.code === "string"
          ? request.body.coachProfile.code
          : current.coachProfile.code,
        email: typeof request.body?.coachProfile?.email === "string"
          ? request.body.coachProfile.email
          : current.coachProfile.email,
      },
      googleOAuth: {
        clientCredentialsPath: typeof request.body?.googleOAuth?.clientCredentialsPath === "string"
          ? request.body.googleOAuth.clientCredentialsPath
          : current.googleOAuth.clientCredentialsPath,
      },
    });
    saveConfig(user.id, next);
    clearSummaryCache();
    response.json({ config: next });
  } catch (error) {
    respondError(response, error, 400);
  }
});

app.post("/api/config/oauth-json", (request, response) => {
  try {
    const user = getRequestUser(request);
    if (!user) {
      respondError(response, new Error("Authentication required"), 401);
      return;
    }
    const rawContents = typeof request.body?.contents === "string" ? request.body.contents : "";
    if (!rawContents.trim()) {
      respondError(response, new Error("contents is required"), 400);
      return;
    }

    const parsed = JSON.parse(rawContents) as { installed?: unknown; web?: unknown };
    if (!parsed.installed && !parsed.web) {
      respondError(response, new Error("OAuth JSON must include installed or web"), 400);
      return;
    }

    mkdirSync(dirname(CREDENTIALS_JSON_PATH), { recursive: true });
    writeFileSync(CREDENTIALS_JSON_PATH, JSON.stringify(parsed, null, 2));

    const current = loadConfig(user.id);
    const next = mergeConfig(current, {
      googleOAuth: {
        clientCredentialsPath: CREDENTIALS_JSON_PATH,
      },
    });
    saveConfig(user.id, next);
    clearSummaryCache();

    response.json({
      config: next,
      savedPath: CREDENTIALS_JSON_PATH,
    });
  } catch (error) {
    respondError(response, error, 400);
  }
});

app.get("/api/google/status", async (request, response) => {
  try {
    const user = getRequestUser(request);
    if (!user) {
      respondError(response, new Error("Authentication required"), 401);
      return;
    }
    const config = loadConfig(user.id);
    const { gmailAccounts, calendarAccounts } = await buildAccountStatuses(config);
    response.json({
      callbackUrl: `${BASE_URL}/auth/google/callback`,
      gmailAccounts,
      calendarAccounts,
      connected: gmailAccounts.some((account) => account.connected) || calendarAccounts.some((account) => account.connected),
    });
  } catch (error) {
    respondError(response, error, 400);
  }
});

app.post("/api/google/start", (request, response) => {
  try {
    const user = getRequestUser(request);
    if (!user) {
      respondError(response, new Error("Authentication required"), 401);
      return;
    }
    const purpose: GoogleAuthPurpose = request.body?.purpose === "calendar" ? "calendar" : "gmail";
    const current = loadConfig(user.id);

    if (typeof request.body?.clientCredentialsPath === "string") {
      saveConfig(user.id, mergeConfig(current, {
        googleOAuth: {
          clientCredentialsPath: request.body.clientCredentialsPath,
        },
      }));
    }

    const state = randomUUID();
    oauthRequests.set(state, {
      status: "pending",
      purpose,
      updatedAt: Date.now(),
      userId: user.id,
      accountId: purpose === "calendar" ? randomUUID() : undefined,
    });

    response.json({
      state,
      authorizationUrl: buildGoogleAuthUrl(loadConfig(user.id), purpose, state),
    });
  } catch (error) {
    respondError(response, error, 400);
  }
});

app.get("/api/google/wait", async (request, response) => {
  const user = getRequestUser(request);
  if (!user) {
    respondError(response, new Error("Authentication required"), 401);
    return;
  }
  const state = typeof request.query.state === "string" ? request.query.state : "";
  if (!state) {
    respondError(response, new Error("state is required"), 400);
    return;
  }

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const current = oauthRequests.get(state);
    if (current?.userId && current.userId !== user.id) {
      respondError(response, new Error("Google connection state is not available"), 404);
      return;
    }
    if (current?.status === "completed") {
      response.json({ connected: true });
      return;
    }
    if (current?.status === "error") {
      respondError(response, new Error(current.message ?? "Google connection failed"), 400);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  respondError(response, new Error("Google connection timed out"), 408);
});

app.get("/auth/google/callback", async (request, response) => {
  const state = typeof request.query.state === "string" ? request.query.state : "";
  const pendingRequest = state ? oauthRequests.get(state) : undefined;

  try {
    const code = typeof request.query.code === "string" ? request.query.code : "";
    if (!code) {
      throw new Error("Authorization code is missing");
    }
    if (!pendingRequest) {
      throw new Error("Google OAuth state is missing or expired");
    }

    if (pendingRequest.purpose === "login") {
      const user = await exchangeGoogleCode(null, code, "login") as AuthenticatedUser;
      setSessionCookie(response, user);
      oauthRequests.set(state, {
        ...pendingRequest,
        status: "completed",
        updatedAt: Date.now(),
      });
      response.redirect("/");
      return;
    }

    if (!pendingRequest.userId) {
      throw new Error("Google OAuth user context is missing");
    }

    const current = loadConfig(pendingRequest.userId);
    const account = await exchangeGoogleCode(current, code, pendingRequest.purpose, pendingRequest.userId, pendingRequest.accountId) as GoogleAccountConfig;
    if (pendingRequest.purpose === "gmail" && !/@gyakuten-coaching\.com$/i.test(account.email || "")) {
      clearSavedTokens(account.tokenPath);
      throw new Error("Gmail は @gyakuten-coaching.com のアカウントを接続してください。");
    }
    const next = pendingRequest.purpose === "gmail"
      ? mergeConfig(current, {
          googleAccounts: {
            ...current.googleAccounts,
            gmails: upsertAccount(current.googleAccounts.gmails, account),
          },
        })
      : mergeConfig(current, {
          googleAccounts: {
            ...current.googleAccounts,
            calendars: upsertAccount(current.googleAccounts.calendars, account),
          },
        });

    saveConfig(pendingRequest.userId, next);
    clearSummaryCache();
    oauthRequests.set(state, {
      ...pendingRequest,
      status: "completed",
      updatedAt: Date.now(),
    });

    response.type("html").send(`<!doctype html>
<html>
  <body style="font-family: sans-serif; padding: 32px">
    <h1>Google connection complete</h1>
    <p>You can close this tab and return to GC Greenfield.</p>
  </body>
</html>`);
  } catch (error) {
    if (pendingRequest && state) {
      oauthRequests.set(state, {
        ...pendingRequest,
        status: "error",
        updatedAt: Date.now(),
        message: error instanceof Error ? error.message : "Unknown Google OAuth error",
      });
    }
    respondError(response, error, 400);
  }
});

app.post("/api/google/disconnect", async (request, response) => {
  try {
    const user = getRequestUser(request);
    if (!user) {
      respondError(response, new Error("Authentication required"), 401);
      return;
    }
    const purpose: GoogleAuthPurpose = request.body?.purpose === "calendar" ? "calendar" : "gmail";
    const accountId = typeof request.body?.accountId === "string" ? request.body.accountId : undefined;
    const current = loadConfig(user.id);

    disconnectGoogleAccount(current, purpose, accountId);

    const next = purpose === "gmail"
      ? mergeConfig(current, {
          googleAccounts: {
            ...current.googleAccounts,
            gmails: current.googleAccounts.gmails.filter((account) => account.id !== accountId),
          },
        })
      : mergeConfig(current, {
          googleAccounts: {
            ...current.googleAccounts,
            calendars: current.googleAccounts.calendars.filter((account) => account.id !== accountId),
          },
        });

    saveConfig(user.id, next);
    clearSummaryCache();
    const { gmailAccounts, calendarAccounts } = await buildAccountStatuses(next);
    response.json({
      gmailAccounts,
      calendarAccounts,
    });
  } catch (error) {
    respondError(response, error, 400);
  }
});

app.get("/api/google/calendars", async (request, response) => {
  try {
    const user = getRequestUser(request);
    if (!user) {
      respondError(response, new Error("Authentication required"), 401);
      return;
    }
    const config = loadConfig(user.id);
    response.json({
      calendars: await getCachedCalendars(config),
    });
  } catch (error) {
    respondError(response, error, 400);
  }
});

app.get("/api/google/events", async (request, response) => {
  try {
    const user = getRequestUser(request);
    if (!user) {
      respondError(response, new Error("Authentication required"), 401);
      return;
    }
    const start = typeof request.query.start === "string" ? request.query.start : "";
    const end = typeof request.query.end === "string" ? request.query.end : "";
    const calendarIds = typeof request.query.calendarIds === "string" && request.query.calendarIds.length > 0
      ? request.query.calendarIds.split(",").map((value) => value.trim()).filter(Boolean)
      : [];

    if (!start || !end) {
      respondError(response, new Error("start and end are required"), 400);
      return;
    }

    const config = loadConfig(user.id);
    const [events, submissions] = await Promise.all([
      listCalendarEvents(config, {
        start,
        end,
        selectedCalendarIds: calendarIds,
      }),
      getCachedGmailSubmissions(user.id, config, {
        start,
        end,
      }),
    ]);

    response.json({
      events: decorateCalendarEvents(events, submissions, loadRuntimeState(user.id)),
    });
  } catch (error) {
    respondError(response, error, 400);
  }
});

app.get("/api/workspace/summary", async (request, response) => {
  try {
    const user = getRequestUser(request);
    if (!user) {
      respondError(response, new Error("Authentication required"), 401);
      return;
    }
    const start = typeof request.query.start === "string" ? request.query.start : "";
    const end = typeof request.query.end === "string" ? request.query.end : "";
    const calendarIds = typeof request.query.calendarIds === "string" && request.query.calendarIds.length > 0
      ? request.query.calendarIds.split(",").map((value) => value.trim()).filter(Boolean)
      : [];

    if (!start || !end) {
      respondError(response, new Error("start and end are required"), 400);
      return;
    }

    const config = loadConfig(user.id);
    const payload = await getWorkspaceSummaryPayload(user.id, config, { start, end, calendarIds });
    response.json(payload);
  } catch (error) {
    respondError(response, error, 400);
  }
});

app.post("/api/reconciliations/:id/override", async (request, response) => {
  try {
    const user = getRequestUser(request);
    if (!user) {
      respondError(response, new Error("Authentication required"), 401);
      return;
    }
    const id = request.params.id;
    const override: ReconciliationOverrideRecord = {
      studentName: typeof request.body?.studentName === "string" ? request.body.studentName : undefined,
      kind: typeof request.body?.kind === "string" ? request.body.kind as ReconciliationKind : undefined,
      ignored: typeof request.body?.ignored === "boolean" ? request.body.ignored : undefined,
      note: typeof request.body?.note === "string" ? request.body.note : undefined,
      updatedAt: nowIso(),
    };
    saveReconciliationOverride(user.id, id, override);
    clearSummaryCache();
    response.json({ ok: true });
  } catch (error) {
    respondError(response, error, 400);
  }
});

app.post("/api/reconciliations/:id/ignore", async (request, response) => {
  try {
    const user = getRequestUser(request);
    if (!user) {
      respondError(response, new Error("Authentication required"), 401);
      return;
    }
    saveReconciliationOverride(user.id, request.params.id, {
      ...(loadRuntimeState(user.id).reconciliationOverrides[request.params.id] ?? {}),
      ignored: true,
      note: typeof request.body?.note === "string" ? request.body.note : undefined,
      updatedAt: nowIso(),
    });
    clearSummaryCache();
    response.json({ ok: true });
  } catch (error) {
    respondError(response, error, 400);
  }
});

app.post("/api/reconciliations/:id/restore", async (request, response) => {
  try {
    const user = getRequestUser(request);
    if (!user) {
      respondError(response, new Error("Authentication required"), 401);
      return;
    }
    saveReconciliationOverride(user.id, request.params.id, {
      ...(loadRuntimeState(user.id).reconciliationOverrides[request.params.id] ?? {}),
      ignored: false,
      updatedAt: nowIso(),
    });
    clearSummaryCache();
    response.json({ ok: true });
  } catch (error) {
    respondError(response, error, 400);
  }
});

app.post("/api/submissions/:id/invalidate", async (request, response) => {
  try {
    const user = getRequestUser(request);
    if (!user) {
      respondError(response, new Error("Authentication required"), 401);
      return;
    }
    const invalidated = typeof request.body?.invalidated === "boolean" ? request.body.invalidated : true;
    setSubmissionInvalidated(user.id, request.params.id, invalidated);
    clearSummaryCache();
    response.json({ ok: true, invalidated });
  } catch (error) {
    respondError(response, error, 400);
  }
});

app.post("/api/students/:studentKey/code", async (request, response) => {
  try {
    const user = getRequestUser(request);
    if (!user) {
      respondError(response, new Error("Authentication required"), 401);
      return;
    }
    const studentKey = request.params.studentKey;
    const studentCode = typeof request.body?.studentCode === "string" ? request.body.studentCode.trim() : "";
    const studentName = typeof request.body?.studentName === "string" ? request.body.studentName.trim() : studentKey;
    if (!studentKey || !studentCode) {
      respondError(response, new Error("studentKey and studentCode are required"), 400);
      return;
    }
    saveStudentCodeDirectoryEntry(user.id, {
      studentKey,
      studentName,
      studentCode,
      source: "manual",
      confidence: 1,
      evidenceCount: typeof request.body?.evidenceCount === "number" ? request.body.evidenceCount : 0,
      updatedAt: nowIso(),
    });
    clearSummaryCache();
    response.json({ ok: true });
  } catch (error) {
    respondError(response, error, 400);
  }
});

app.post("/api/students/:studentKey/profile", async (request, response) => {
  try {
    const user = getRequestUser(request);
    if (!user) {
      respondError(response, new Error("Authentication required"), 401);
      return;
    }
    const studentKey = request.params.studentKey;
    const studentName = typeof request.body?.studentName === "string" ? request.body.studentName.trim() : studentKey;
    if (!studentKey) {
      respondError(response, new Error("studentKey is required"), 400);
      return;
    }
    const weekday = typeof request.body?.weekday === "number"
      ? request.body.weekday
      : request.body?.weekday === null || request.body?.weekday === ""
        ? null
        : undefined;
    const time = typeof request.body?.time === "string" ? request.body.time.trim() : "";
    const durationMinutes = typeof request.body?.durationMinutes === "number"
      ? request.body.durationMinutes
      : request.body?.durationMinutes === null || request.body?.durationMinutes === ""
        ? null
        : undefined;
    const expectedKinds = normalizeRoutineExpectedKinds(request.body?.expectedKinds);
    const course = normalizeRoutineCourse(request.body?.course);
    const teachingType = normalizeRoutineTeachingType(request.body?.teachingType);
    const note = typeof request.body?.note === "string" ? request.body.note.trim() : "";

    saveStudentRoutineProfile(user.id, {
      studentKey,
      studentName,
      course,
      teachingType,
      weekday,
      time,
      durationMinutes,
      expectedKinds: deriveExpectedKindsFromRoutine(course, teachingType, expectedKinds),
      note,
      source: "manual",
      confidence: 1,
      evidenceCount: typeof request.body?.evidenceCount === "number" ? request.body.evidenceCount : 0,
      updatedAt: nowIso(),
    });
    clearSummaryCache();
    response.json({ ok: true });
  } catch (error) {
    respondError(response, error, 400);
  }
});

app.post("/api/students/:studentKey/calendar-series", async (request, response) => {
  try {
    const user = getRequestUser(request);
    if (!user) {
      respondError(response, new Error("Authentication required"), 401);
      return;
    }
    const studentKey = request.params.studentKey;
    const studentName = typeof request.body?.studentName === "string" ? request.body.studentName.trim() : studentKey;
    const selectionId = typeof request.body?.selectionId === "string" ? request.body.selectionId : "";
    const weekday = typeof request.body?.weekday === "number" ? request.body.weekday : null;
    const time = typeof request.body?.time === "string" ? request.body.time.trim() : "";
    const until = typeof request.body?.until === "string" ? request.body.until : "";
    if (!studentKey || !studentName || !selectionId || weekday === null || !time || !until) {
      respondError(response, new Error("studentKey, studentName, selectionId, weekday, time, until are required"), 400);
      return;
    }

    const [accountId, ...calendarRest] = selectionId.split("::");
    const calendarId = calendarRest.join("::");
    if (!accountId || !calendarId) {
      respondError(response, new Error("selectionId is invalid"), 400);
      return;
    }

    const { start, end } = nextOccurrenceIso(weekday, time);
    await createRecurringCalendarEvent(loadConfig(user.id), {
      accountId,
      calendarId,
      title: `${studentName}さん`,
      start,
      end,
      recurrenceRule: `FREQ=WEEKLY;BYDAY=${["SU", "MO", "TU", "WE", "TH", "FR", "SA"][weekday]};UNTIL=${formatRecurrenceUntil(until)}`,
    });
    clearSummaryCache();
    response.json({ ok: true });
  } catch (error) {
    respondError(response, error, 400);
  }
});

app.patch("/api/calendar-sessions/:id", async (request, response) => {
  try {
    const user = getRequestUser(request);
    if (!user) {
      respondError(response, new Error("Authentication required"), 401);
      return;
    }
    const accountId = typeof request.body?.accountId === "string" ? request.body.accountId : "";
    const calendarId = typeof request.body?.googleCalendarId === "string" ? request.body.googleCalendarId : "";
    const eventId = typeof request.body?.googleEventId === "string" ? request.body.googleEventId : "";
    const title = typeof request.body?.title === "string" ? request.body.title.trim() : "";
    if (!accountId || !calendarId || !eventId || !title) {
      respondError(response, new Error("accountId, googleCalendarId, googleEventId, title are required"), 400);
      return;
    }
    await renameCalendarEvent(loadConfig(user.id), { accountId, calendarId, eventId, title });
    clearSummaryCache();
    response.json({ ok: true });
  } catch (error) {
    respondError(response, error, 400);
  }
});

app.post("/api/calendar-suggestions/apply", async (request, response) => {
  try {
    const user = getRequestUser(request);
    if (!user) {
      respondError(response, new Error("Authentication required"), 401);
      return;
    }
    const suggestion = request.body?.suggestion as CalendarActionSuggestion | undefined;
    if (!suggestion?.type || !suggestion.start || !suggestion.title) {
      respondError(response, new Error("suggestion is required"), 400);
      return;
    }

    if (suggestion.type === "move") {
      if (!suggestion.sourceEvent) {
        respondError(response, new Error("sourceEvent is required for move"), 400);
        return;
      }
      const config = loadConfig(user.id);
      const sourceCalendar = (await getCachedCalendars(config)).find((entry) =>
        entry.accountId === suggestion.sourceEvent?.accountId
        && entry.calendarId === suggestion.sourceEvent?.googleCalendarId,
      );
      if (sourceCalendar && !sourceCalendar.canEdit) {
        respondError(response, new Error("元予定のカレンダーに書き込み権限がないため、移動できません。新規作成を使ってください。"), 400);
        return;
      }
      await moveCalendarEvent(config, {
        accountId: suggestion.sourceEvent.accountId,
        calendarId: suggestion.sourceEvent.googleCalendarId,
        eventId: suggestion.sourceEvent.googleEventId,
        start: suggestion.start,
        end: suggestion.end,
      });
    } else {
      const selectionId = typeof request.body?.selectionId === "string" ? request.body.selectionId : "";
      const [accountId, ...calendarRest] = selectionId.split("::");
      const calendarId = calendarRest.join("::");
      if (!accountId || !calendarId) {
        respondError(response, new Error("selectionId is required for create"), 400);
        return;
      }
      const config = loadConfig(user.id);
      const created = await createCalendarEvent(config, {
        accountId,
        calendarId,
        title: suggestion.title,
        start: suggestion.start,
        end: suggestion.end,
      });
      const calendar = (await getCachedCalendars(config)).find((entry) => entry.id === selectionId);
      clearSummaryCache();
      response.json({
        ok: true,
        event: {
          id: `${selectionId}::${created.googleEventId || randomUUID()}`,
          title: created.title,
          start: created.start,
          end: created.end,
          url: created.url,
          backgroundColor: calendar?.backgroundColor,
          borderColor: calendar?.backgroundColor,
          extendedProps: {
            calendarId: selectionId,
            accountId,
            accountEmail: calendar?.accountEmail ?? accountId,
            googleCalendarId: calendarId,
            googleEventId: created.googleEventId,
          },
        },
      });
      return;
    }
    clearSummaryCache();
    response.json({ ok: true });
  } catch (error) {
    respondError(response, error, 400);
  }
});

app.delete("/api/calendar-sessions/:id", async (request, response) => {
  try {
    const user = getRequestUser(request);
    if (!user) {
      respondError(response, new Error("Authentication required"), 401);
      return;
    }
    const accountId = typeof request.body?.accountId === "string" ? request.body.accountId : "";
    const calendarId = typeof request.body?.googleCalendarId === "string" ? request.body.googleCalendarId : "";
    const eventId = typeof request.body?.googleEventId === "string" ? request.body.googleEventId : "";
    if (!accountId || !calendarId || !eventId) {
      respondError(response, new Error("accountId, googleCalendarId, googleEventId are required"), 400);
      return;
    }
    await deleteCalendarEvent(loadConfig(user.id), { accountId, calendarId, eventId });
    clearSummaryCache();
    response.json({ ok: true });
  } catch (error) {
    respondError(response, error, 400);
  }
});

app.post("/api/autofill/plan", async (request, response) => {
  try {
    const user = getRequestUser(request);
    if (!user) {
      respondError(response, new Error("Authentication required"), 401);
      return;
    }
    const id = typeof request.body?.reconciliationId === "string" ? request.body.reconciliationId : "";
    const kindOverride = typeof request.body?.kindOverride === "string" ? request.body.kindOverride as ReconciliationKind : undefined;
    const start = typeof request.body?.start === "string" ? request.body.start : "";
    const end = typeof request.body?.end === "string" ? request.body.end : "";
    const calendarIds = Array.isArray(request.body?.calendarIds)
      ? request.body.calendarIds.filter((value: unknown): value is string => typeof value === "string")
      : [];
    if (!id || !start || !end) {
      respondError(response, new Error("reconciliationId, start, end are required"), 400);
      return;
    }
    const config = loadConfig(user.id);
    const payload = await getWorkspaceSummaryPayload(user.id, config, { start, end, calendarIds });
    const record = (payload.applications as ReconciliationRecord[]).find((item) => item.id === id);
    if (!record) {
      respondError(response, new Error("Reconciliation not found"), 404);
      return;
    }
    const runtimeState = loadRuntimeState(user.id);
    const existingTask = Object.values(runtimeState.autofillTasks).find((task) =>
      task.reconciliationId === id && (task.plannedKind ?? record.kind) === (kindOverride ?? record.kind),
    );
    if (existingTask?.status === "autofill_running") {
      respondError(response, new Error("この申請は現在送信準備中です。"), 409);
      return;
    }
    if (deriveApplicationStatus(record.start) === "upcoming") {
      respondError(response, new Error("未来の予定は送信準備できません。"), 400);
      return;
    }
    const plan = inferAutofillPlan(record, config, kindOverride ?? record.kind);
    const plannedTask = plan.task
      ?? (kindOverride ? undefined : record.autofillTask ?? undefined);
    if (!plannedTask) {
      respondError(response, new Error(plan.reason || record.autofillReason || "Autofill task cannot be planned"), 400);
      return;
    }
    const task: AutofillTaskRecord = {
      ...plannedTask,
      status: plan.eligibility === "ready" ? "autofill_ready" : "autofill_blocked",
      updatedAt: nowIso(),
      createdAt: plannedTask.createdAt || nowIso(),
      lastError: null,
    };
    saveAutofillTask(user.id, task);
    clearSummaryCache();
    response.json({ task, reconciliation: record, eligibility: plan.eligibility, reason: plan.reason });
  } catch (error) {
    respondError(response, error, 400);
  }
});

app.post("/api/autofill/run", async (request, response) => {
  try {
    const user = getRequestUser(request);
    if (!user) {
      respondError(response, new Error("Authentication required"), 401);
      return;
    }
    const id = typeof request.body?.reconciliationId === "string" ? request.body.reconciliationId : "";
    const kindOverride = typeof request.body?.kindOverride === "string" ? request.body.kindOverride as ReconciliationKind : undefined;
    const start = typeof request.body?.start === "string" ? request.body.start : "";
    const end = typeof request.body?.end === "string" ? request.body.end : "";
    const calendarIds = Array.isArray(request.body?.calendarIds)
      ? request.body.calendarIds.filter((value: unknown): value is string => typeof value === "string")
      : [];
    if (!id || !start || !end) {
      respondError(response, new Error("reconciliationId, start, end are required"), 400);
      return;
    }
    const config = loadConfig(user.id);
    const payload = await getWorkspaceSummaryPayload(user.id, config, { start, end, calendarIds });
    const record = (payload.applications as ReconciliationRecord[]).find((item) => item.id === id);
    if (!record) {
      respondError(response, new Error("Reconciliation not found"), 404);
      return;
    }
    const runtimeState = loadRuntimeState(user.id);
    const existingTask = Object.values(runtimeState.autofillTasks).find((task) =>
      task.reconciliationId === id && (task.plannedKind ?? record.kind) === (kindOverride ?? record.kind),
    );
    if (existingTask?.status === "autofill_running") {
      respondError(response, new Error("この申請は現在送信準備中です。"), 409);
      return;
    }
    if (deriveApplicationStatus(record.start) === "upcoming") {
      respondError(response, new Error("未来の予定は送信準備できません。"), 400);
      return;
    }
    const plan = inferAutofillPlan(record, config, kindOverride ?? record.kind);
    const plannedTask = plan.task
      ?? (kindOverride ? undefined : record.autofillTask ?? undefined);
    if (!plannedTask) {
      respondError(response, new Error(plan.reason || record.autofillReason || "Autofill task cannot be created"), 400);
      return;
    }
    const rerunPendingTask = existingTask?.status === "awaiting_user_submit" || existingTask?.status === "submitted_confirmed";
    const task: AutofillTaskRecord = rerunPendingTask
      ? {
          ...existingTask,
          status: "autofill_ready",
          updatedAt: nowIso(),
          lastError: null,
        }
      : {
          ...plannedTask,
          status: plan.eligibility === "ready" ? "autofill_ready" : "autofill_blocked",
          updatedAt: nowIso(),
          createdAt: plannedTask.createdAt || nowIso(),
        };
    if (!rerunPendingTask && plan.eligibility !== "ready") {
      respondError(response, new Error(plan.reason || record.autofillReason || "自動入力に必要な情報が不足しています。"), 400);
      return;
    }
    saveAutofillTask(user.id, {
      ...task,
      status: "awaiting_user_submit",
      updatedAt: nowIso(),
    });
    const execution = await runAutofillTask(task);
    const finalizedTask: AutofillTaskRecord = {
      ...task,
      status: "awaiting_user_submit",
      missingFields: execution.missingQuestions,
      updatedAt: nowIso(),
      lastError: execution.error ?? null,
    };
    saveAutofillTask(user.id, finalizedTask);
    clearSummaryCache();
    response.json({
      task: finalizedTask,
      pageUrl: execution.pageUrl,
      submitReady: execution.submitReady,
    });
  } catch (error) {
    respondError(response, error, 400);
  }
});

app.post("/api/bridge/forms/claim-next", async (request, response) => {
  try {
    const user = getRequestUser(request);
    if (!user) {
      respondError(response, new Error("Authentication required"), 401);
      return;
    }
    const formKey = typeof request.body?.formKey === "string" ? request.body.formKey : "";
    const taskId = typeof request.body?.taskId === "string" ? request.body.taskId : "";
    const runtimeState = loadRuntimeState(user.id);
    const candidate = taskId
      ? runtimeState.autofillTasks[taskId]
      : Object.values(runtimeState.autofillTasks).find((task) =>
          task.formKey === formKey && ["autofill_ready", "autofill_blocked", "awaiting_user_submit", "error"].includes(task.status),
        );

    if (!candidate) {
      respondError(response, new Error("No pending autofill task found for this form."), 404);
      return;
    }
    const next: AutofillTaskRecord = {
      ...candidate,
      status: candidate.status === "error" ? "autofill_ready" : candidate.status,
      updatedAt: nowIso(),
      lastError: null,
    };
    saveAutofillTask(user.id, next);
    response.json({ task: next, formUrl: FORM_URLS[next.formKey] });
  } catch (error) {
    respondError(response, error, 400);
  }
});

app.post("/api/bridge/forms/:id/autofill-complete", async (request, response) => {
  try {
    const user = getRequestUser(request);
    if (!user) {
      respondError(response, new Error("Authentication required"), 401);
      return;
    }
    const runtimeState = loadRuntimeState(user.id);
    const task = runtimeState.autofillTasks[request.params.id];
    if (!task) {
      respondError(response, new Error("Task not found."), 404);
      return;
    }
    const missingQuestions = Array.isArray(request.body?.missingQuestions)
      ? request.body.missingQuestions.filter((value: unknown): value is string => typeof value === "string")
      : [];
    const error = typeof request.body?.error === "string" ? request.body.error : null;
    const next: AutofillTaskRecord = {
      ...task,
      status: "awaiting_user_submit",
      missingFields: missingQuestions,
      lastError: error ?? null,
      updatedAt: nowIso(),
    };
    saveAutofillTask(user.id, next);
    clearSummaryCache();
    response.json({ task: next });
  } catch (error) {
    respondError(response, error, 400);
  }
});

app.post("/api/bridge/forms/:id/submitted", async (request, response) => {
  try {
    const user = getRequestUser(request);
    if (!user) {
      respondError(response, new Error("Authentication required"), 401);
      return;
    }
    const runtimeState = loadRuntimeState(user.id);
    const task = runtimeState.autofillTasks[request.params.id];
    if (!task) {
      respondError(response, new Error("Task not found."), 404);
      return;
    }
    const next: AutofillTaskRecord = {
      ...task,
      status: "awaiting_user_submit",
      updatedAt: nowIso(),
      lastError: null,
    };
    saveAutofillTask(user.id, next);
    clearSummaryCache();
    response.json({ task: next });
  } catch (error) {
    respondError(response, error, 400);
  }
});

app.post("/api/notifications/stale/send", async (request, response) => {
  response.json({ sent: false, reason: "disabled" });
});

app.listen(APP_PORT, () => {
  console.log(`GC Greenfield listening on ${BASE_URL}`);
});
