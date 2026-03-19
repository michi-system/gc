import { google, type gmail_v1 } from "googleapis";

import { createOAuthClient, loadSavedTokens } from "./google.js";
import type { AppConfig, GmailSubmissionRecord, GoogleAccountConfig } from "./types.js";

const FORM_RECEIPT_QUERY_BASE = "from:forms-receipts-noreply@google.com";

const FORM_TITLES = {
  work_report: "作業時間報告-2025年度",
  schedule_change: "コーチング日程変更フォーム",
  handoff: "引き継ぎフォーム",
} as const;

const FIELD_TITLES = {
  work_report: [
    "メールアドレス",
    "お名前_漢字フルネーム",
    "コーチコード",
    "作業日時",
    "該当作業",
    "コーチング以外の作業時間(時間:分)",
    "作業内容",
    "具体的な作業内容",
    "業務依頼者",
    "生徒コード",
    "生徒氏名(漢字フルネーム)",
    "コーチングの参加状況",
    "今日の振り返り",
  ],
  schedule_change: [
    "メールアドレス",
    "お名前",
    "コーチング日程を変更する生徒さんのお名前を漢字で記入してください。\n※名字と名前の間に半角スペースを入れてください",
    "調整前(通常時)のコーチング時間を教えてください。",
    "変更後のコーチング時間を教えてください。",
    "コーチングの日程変更理由を教えてください。",
  ],
  handoff: [
    "メールアドレス",
    "お名前_漢字フルネーム",
    "コーチコード",
    "生徒氏名(漢字フルネーム)",
    "生徒コード",
    "引き継ぎ項目",
  ],
} as const;

const WORK_REPORT_TASK_CATEGORIES = [
  "コーチング",
  "コーチング以外",
  "コーチング業務",
] as const;

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
    const body = extractBodyFromPart(child);
    if (body) {
      return body;
    }
  }

  if (part.body?.data) {
    return decodeBase64Url(part.body.data);
  }

  return "";
}

function messageHeader(message: gmail_v1.Schema$Message, name: string): string {
  const header = (message.payload?.headers ?? []).find((item) => item.name?.toLowerCase() === name.toLowerCase());
  return header?.value ?? "";
}

function cleanAnswer(value: string): string {
  return value
    .replace(/^\*+/, "")
    .replace(/\r/g, "")
    .replace(/^\s*\*\s*$/gm, "")
    .replace(/^[\s:：-]+/, "")
    .replace(/^※.*$/gm, "")
    .replace(/^YYYY$|^MM$|^DD$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/Google フォーム[\s\S]*$/i, "")
    .trim();
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\u3000/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLooseText(value: string | null | undefined): string {
  return normalizeText(value).replace(/[:：]$/, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function titlePattern(title: string): RegExp {
  const normalized = normalizeLooseText(title);
  return new RegExp(escapeRegExp(normalized).replace(/\s+/g, "\\s+"), "i");
}

function answerBodyFrom(body: string): string {
  return body.includes("フォームの回答")
    ? body.slice(body.lastIndexOf("フォームの回答"))
    : body;
}

function extractOrderedAnswers(body: string, titles: readonly string[]): Record<string, string> {
  const answerBody = answerBodyFrom(body);
  const matches: Array<{ title: string; start: number; end: number }> = [];
  let cursor = 0;

  for (const title of titles) {
    const slice = answerBody.slice(cursor);
    const match = titlePattern(title).exec(slice);
    if (!match) {
      continue;
    }
    const start = cursor + match.index;
    const end = start + match[0].length;
    matches.push({ title, start, end });
    cursor = end;
  }

  const answers: Record<string, string> = {};
  matches.forEach((match, index) => {
    const nextStart = matches[index + 1]?.start ?? answerBody.length;
    const value = cleanAnswer(answerBody.slice(match.end, nextStart));
    if (value) {
      answers[match.title] = value;
    }
  });
  return answers;
}

function answersFor(body: string, titles: readonly string[]): Record<string, string> {
  return extractOrderedAnswers(body, titles);
}

function extractFieldBlock(body: string, label: string, nextLabels: string[]): string {
  const answerBody = answerBodyFrom(body);
  const start = answerBody.indexOf(label);
  if (start === -1) {
    return "";
  }
  const afterLabel = answerBody.slice(start + label.length);
  const nextOffsets = nextLabels
    .map((nextLabel) => afterLabel.indexOf(nextLabel))
    .filter((offset) => offset >= 0);
  const end = nextOffsets.length > 0 ? Math.min(...nextOffsets) : afterLabel.length;
  return cleanAnswer(afterLabel.slice(0, end));
}

function linesOf(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function lastMatchingOption(block: string | undefined, options: readonly string[]): string | undefined {
  const lines = linesOf(block ?? "");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (options.includes(line as (typeof options)[number])) {
      return line;
    }
  }
  return undefined;
}

function firstMatchingValue(value: string | undefined, pattern: RegExp): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.match(pattern)?.[0];
}

function extractCoachCode(value: string | undefined): string | undefined {
  return firstMatchingValue(value, /gco\d+/iu);
}

function extractStudentCode(value: string | undefined): string | undefined {
  return firstMatchingValue(value, /s\d+/iu);
}

function extractParticipationStatus(value: string | undefined): string | undefined {
  return lastMatchingOption(value ?? "", [
    "当日参加",
    "当日キャンセル",
    "別週に振替予定",
    "振替実施",
    "初回コーチング（入塾後の運営面談）",
  ]);
}

function inferStudentNamesFromText(value: string | undefined): string[] {
  const source = String(value ?? "");
  if (!source) {
    return [];
  }
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const uniq = (items: string[]) => Array.from(new Set(items.map((item) => item.trim()).filter(Boolean)));
  const cleanCandidate = (item: string): string => item
    .normalize("NFKC")
    .replace(/^[\p{Z}\s]+|[\p{Z}\s]+$/gu, "")
    .replace(/[（(].*?[）)]/gu, "")
    .replace(/の$/u, "")
    .replace(/(?:さん|様|くん|君|ちゃん)$/u, "")
    .replace(/[\p{Z}\s]+/gu, " ")
    .trim();
  const looksLikeStudentName = (item: string): boolean => {
    const normalized = cleanCandidate(item);
    if (!normalized) {
      return false;
    }
    if (/^(?:対応|作成|内容|項目)$/u.test(normalized)) {
      return false;
    }
    if (/引き継ぎ生徒|study\s*plus|スタプラ|カルテ|初回カルテ|英語|数学|国語|理科|社会|二人分|2人分/u.test(normalized)) {
      return false;
    }
    return /[一-龯々ぁ-んァ-ヶー]/u.test(normalized) && normalized.length >= 2;
  };

  const matches = Array.from(source.matchAll(/([一-龯々ぁ-んァ-ヶー]+(?:\s+[一-龯々ぁ-んァ-ヶー]+)?)さん/gu))
    .map((match) => match[1] ?? "")
    .map(cleanCandidate)
    .filter(looksLikeStudentName);

  if (matches.length > 0) {
    return uniq(matches);
  }

  const lineLevelMatches = lines
    .flatMap((line) => [
      line.match(/(?:^|[\s　])([一-龯々ぁ-んァ-ヶー]{1,6}(?:\s+[一-龯々ぁ-んァ-ヶー]{1,6})?)\s*(?:さん)?\s+(?=小論文|ティーチング|過去問|添削|準備|追加対応|追加作業|時間外作業)/u)?.[1],
      line.match(/(?:^|[\s　])([一-龯々ぁ-んァ-ヶー]{1,6}(?:\s+[一-龯々ぁ-んァ-ヶー]{1,6})?)\s*の(?=小論文|ティーチング|過去問|添削|準備|追加対応|追加作業|時間外作業)/u)?.[1],
      line.match(/(?:^|[\s　])([一-龯々ぁ-んァ-ヶー]{1,6}(?:\s+[一-龯々ぁ-んァ-ヶー]{1,6})?)\s*(?:さん)?\s+(?=引き継ぎ)/u)?.[1],
      line.match(/(?:^|[\s　])([一-龯々ぁ-んァ-ヶー]{1,6}(?:\s+[一-龯々ぁ-んァ-ヶー]{1,6})?)\s*の(?=引き継ぎ)/u)?.[1],
    ])
    .map((match) => cleanCandidate(match ?? ""))
    .filter(looksLikeStudentName);
  if (lineLevelMatches.length > 0) {
    return uniq(lineLevelMatches);
  }

  if (/引き継ぎ/u.test(source)) {
    const handoffCandidates = [
      ...Array.from(source.matchAll(/引き継ぎ[・:：\s]*([一-龯々ぁ-んァ-ヶー]{1,6}\s*[一-龯々ぁ-んァ-ヶー]{1,6})/gu)).map((match) => match[1] ?? ""),
      ...Array.from(source.matchAll(/[（(]([^）)]+)[）)]/gu))
        .flatMap((match) => (match[1] ?? "").split(/[・、,\/]/))
        .map(cleanCandidate),
    ]
      .filter(looksLikeStudentName);
    if (handoffCandidates.length > 0) {
      return uniq(handoffCandidates);
    }
    return [];
  }

  const fallback = source.match(/([一-龯々ぁ-んァ-ヶー]{2,}\s*[一-龯々ぁ-んァ-ヶー]{1,})(?=小論文|添削|準備|ティーチング|過去問|引き継ぎ|追加対応|追加作業|時間外作業)/u);
  return fallback?.[1]
    && looksLikeStudentName(fallback[1])
    ? [cleanCandidate(fallback[1])]
    : [];
}

function parseDateTimeBlock(block: string | undefined): { date?: string; time?: string } {
  const compact = String(block ?? "").replace(/\r/g, "").replace(/\n+/g, " ");
  const dateMatch = compact.match(/(\d{4})\s*\/\s*(\d{2})\s*\/\s*(\d{2})/);
  const timeMatch = compact.match(/(\d{1,2})\s*:\s*(\d{2})/);
  return {
    date: dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : undefined,
    time: timeMatch ? `${String(timeMatch[1]).padStart(2, "0")}:${timeMatch[2]}` : undefined,
  };
}

function parseScheduleChangeSubmission(body: string): {
  studentName?: string;
  coachName?: string;
  submitterEmail?: string;
  originalDate?: string;
  originalTime?: string;
  targetDate?: string;
  targetTime?: string;
  reason?: string;
} {
  const answers = answersFor(body, FIELD_TITLES.schedule_change);
  const submitterEmail = answers["メールアドレス"];
  const coachName = answers["お名前"];
  const studentName = answers["コーチング日程を変更する生徒さんのお名前を漢字で記入してください。\n※名字と名前の間に半角スペースを入れてください"];
  const beforeBlock = answers["調整前(通常時)のコーチング時間を教えてください。"];
  const afterBlock = answers["変更後のコーチング時間を教えてください。"];
  const reason = answers["コーチングの日程変更理由を教えてください。"];
  const before = parseDateTimeBlock(beforeBlock);
  const after = parseDateTimeBlock(afterBlock);
  return {
    studentName,
    coachName,
    submitterEmail,
    originalDate: before.date,
    originalTime: before.time,
    targetDate: after.date,
    targetTime: after.time,
    reason,
  };
}

function parseWorkReportSubmission(body: string): {
  studentName?: string;
  studentCode?: string;
  coachName?: string;
  coachCode?: string;
  submitterEmail?: string;
  sessionDate?: string;
  taskCategory?: string;
  taskLabel?: string;
  detailedTask?: string;
  participationStatus?: string;
  intent?: "main" | "extra_thirty" | "handoff" | "administrative" | "other";
  inferredHandoffStudentNames?: string[];
  inferredStudentNames?: string[];
} {
  const answers = answersFor(body, FIELD_TITLES.work_report);
  const submitterEmail = answers["メールアドレス"];
  const coachName = answers["お名前_漢字フルネーム"];
  const coachCode = extractCoachCode(answers["コーチコード"]);
  const dateBlock = answers["作業日時"];
  const taskCategoryBlock = answers["該当作業"];
  const taskCategory = lastMatchingOption(taskCategoryBlock, WORK_REPORT_TASK_CATEGORIES);
  const detailedTask = answers["具体的な作業内容"] || answers["作業内容"];
  const studentCode = extractStudentCode(answers["生徒コード"]);
  const studentNameBlock = answers["生徒氏名(漢字フルネーム)"];
  const participationStatus = extractParticipationStatus(answers["コーチングの参加状況"]);
  const studentName = studentNameBlock || undefined;
  const parsedDate = parseDateTimeBlock(dateBlock);
  const inferredStudentNames = inferStudentNamesFromText(detailedTask);
  const normalizedTaskText = `${taskCategory ?? ""}\n${detailedTask ?? ""}`;
  const intent: "main" | "extra_thirty" | "handoff" | "administrative" | "other" = /研修|研修動画|動画の視聴|動画視聴|フォームの回答|全体研修/u.test(normalizedTaskText)
    ? "administrative"
    : /引き継ぎ/u.test(normalizedTaskText)
      ? "handoff"
      : /小論文|ティーチング|過去問|添削|準備|時間外作業/u.test(normalizedTaskText)
        ? "extra_thirty"
        : taskCategory === "コーチング" || taskCategory === "コーチング業務"
          ? "main"
          : "other";
  const inferredHandoffStudentNames = /引き継ぎ/.test(detailedTask)
    ? Array.from(new Set([
        ...inferredStudentNames,
        studentName?.trim(),
      ].filter((name): name is string => Boolean(name))))
    : [];
  return {
    studentName: studentName || inferredStudentNames[0],
    studentCode: studentCode || undefined,
    coachName,
    coachCode: coachCode || undefined,
    submitterEmail,
    sessionDate: parsedDate.date,
    taskCategory,
    taskLabel: taskCategory || detailedTask || undefined,
    detailedTask: detailedTask || undefined,
    participationStatus: participationStatus || undefined,
    intent,
    inferredHandoffStudentNames,
    inferredStudentNames,
  };
}

function parseHandoffSubmission(body: string): {
  studentName?: string;
  studentCode?: string;
  coachName?: string;
  coachCode?: string;
  submitterEmail?: string;
  policy?: "advance_premium" | "coach_change" | "substitute";
} {
  const answers = answersFor(body, FIELD_TITLES.handoff);
  const submitterEmail = answers["メールアドレス"];
  const coachName = answers["お名前_漢字フルネーム"];
  const coachCode = extractCoachCode(answers["コーチコード"]);
  const studentName = answers["生徒氏名(漢字フルネーム)"];
  const studentCode = extractStudentCode(answers["生徒コード"]);
  const policyValue = answers["引き継ぎ項目"];
  const policy = /アドバンス|プレミアム/u.test(policyValue)
    ? "advance_premium"
    : /コーチ変更/u.test(policyValue)
      ? "coach_change"
      : /代行/u.test(policyValue)
        ? "substitute"
        : undefined;
  return {
    studentName: studentName || undefined,
    studentCode: studentCode || undefined,
    coachName: coachName || undefined,
    coachCode: coachCode || undefined,
    submitterEmail: submitterEmail || undefined,
    policy,
  };
}

function detectFormKey(subject: string, body: string): GmailSubmissionRecord["formKey"] | null {
  const haystack = `${subject}\n${body}`;
  if (haystack.includes(FORM_TITLES.work_report)) {
    return "work_report";
  }
  if (haystack.includes(FORM_TITLES.schedule_change)) {
    return "schedule_change";
  }
  if (haystack.includes(FORM_TITLES.handoff)) {
    return "handoff";
  }
  return null;
}

function normalize(value: string | undefined): string {
  return String(value ?? "")
    .replace(/\s+/g, "")
    .replace(/　/g, "")
    .replace(/[^\p{L}\p{N}@._-]/gu, "")
    .toLowerCase();
}

function extractDate(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const match = value.match(/(\d{4})[/-](\d{2})[/-](\d{2})/);
  if (!match) {
    return undefined;
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function shiftIsoDate(value: string, days: number): string {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function formatQueryDate(value: string): string {
  const date = new Date(value);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

function buildReceiptQuery(range?: { start?: string; end?: string }): string {
  const parts = [FORM_RECEIPT_QUERY_BASE];
  if (range?.start) {
    parts.push(`after:${formatQueryDate(shiftIsoDate(range.start, -90))}`);
  }
  if (range?.end) {
    parts.push(`before:${formatQueryDate(shiftIsoDate(range.end, 90))}`);
  }
  if (!range?.start && !range?.end) {
    parts.push("newer_than:180d");
  }
  return parts.join(" ");
}

function submissionLogicalDate(submission: GmailSubmissionRecord): string {
  if (submission.formKey === "work_report") {
    return submission.sessionDate ?? submission.submittedAt.slice(0, 10);
  }
  if (submission.formKey === "schedule_change") {
    return submission.scheduleChange?.targetDate ?? submission.scheduleChange?.originalDate ?? submission.submittedAt.slice(0, 10);
  }
  return submission.submittedAt.slice(0, 10);
}

function parseSubmission(message: gmail_v1.Schema$Message, account: GoogleAccountConfig): GmailSubmissionRecord | null {
  const subject = messageHeader(message, "subject");
  const body = extractBodyFromPart(message.payload);
  const formKey = detectFormKey(subject, body);
  if (!formKey) {
    return null;
  }

  const answers = extractOrderedAnswers(body, FIELD_TITLES[formKey]);
  const scheduleChange = formKey === "schedule_change"
    ? parseScheduleChangeSubmission(body)
    : undefined;
  const workReport = formKey === "work_report"
    ? parseWorkReportSubmission(body)
    : undefined;
  const handoff = formKey === "handoff"
    ? parseHandoffSubmission(body)
    : undefined;
  const studentName = formKey === "schedule_change"
    ? scheduleChange?.studentName
    : formKey === "work_report"
      ? workReport?.studentName
      : handoff?.studentName ?? answers["生徒氏名(漢字フルネーム)"];

  const sessionDate = formKey === "work_report"
    ? (workReport?.sessionDate ?? extractDate(answers["作業日時"]))
    : formKey === "schedule_change"
      ? (scheduleChange?.targetDate ?? scheduleChange?.originalDate)
      : undefined;

  const coachName = formKey === "schedule_change"
    ? scheduleChange?.coachName
    : formKey === "work_report"
      ? workReport?.coachName
      : handoff?.coachName ?? answers["お名前_漢字フルネーム"];

  const coachCode = formKey === "schedule_change"
    ? undefined
    : formKey === "work_report"
      ? workReport?.coachCode
      : handoff?.coachCode ?? answers["コーチコード"];

  const submitterEmail = formKey === "schedule_change"
    ? scheduleChange?.submitterEmail
    : formKey === "work_report"
      ? workReport?.submitterEmail
      : handoff?.submitterEmail ?? answers["メールアドレス"];

  return {
    id: message.id ?? "",
    accountId: account.id,
    accountEmail: account.email,
    subject,
    submittedAt: message.internalDate ? new Date(Number(message.internalDate)).toISOString() : new Date().toISOString(),
    formKey,
    formLabel: FORM_TITLES[formKey],
    studentName: studentName?.trim() || undefined,
    studentCode: formKey === "work_report"
      ? workReport?.studentCode?.trim() || undefined
      : handoff?.studentCode?.trim() || undefined,
    sessionDate,
    coachName: coachName?.trim() || undefined,
    coachCode: coachCode?.trim() || undefined,
    submitterEmail: submitterEmail?.trim().toLowerCase() || undefined,
    workReport: workReport
      ? {
          taskCategory: workReport.taskCategory?.trim() || undefined,
          taskLabel: workReport.taskLabel?.trim() || undefined,
          detailedTask: workReport.detailedTask?.trim() || undefined,
          intent: workReport.intent,
          studentCode: workReport.studentCode?.trim() || undefined,
          participationStatus: workReport.participationStatus?.trim() || undefined,
          inferredHandoffStudentNames: workReport.inferredHandoffStudentNames?.length
            ? workReport.inferredHandoffStudentNames.map((name) => name.trim())
            : undefined,
          inferredStudentNames: workReport.inferredStudentNames?.length
            ? workReport.inferredStudentNames.map((name) => name.trim())
            : undefined,
        }
      : undefined,
    scheduleChange: scheduleChange
      ? {
          originalDate: scheduleChange.originalDate,
          originalTime: scheduleChange.originalTime,
          targetDate: scheduleChange.targetDate,
          targetTime: scheduleChange.targetTime,
          reason: scheduleChange.reason?.trim() || undefined,
        }
      : undefined,
    handoff: handoff
      ? {
          studentCode: handoff.studentCode?.trim() || undefined,
          policy: handoff.policy,
        }
      : undefined,
  };
}

function matchesCoachProfile(config: AppConfig, submission: GmailSubmissionRecord): boolean {
  const profile = config.coachProfile;
  if (!profile.name && !profile.code && !profile.email) {
    return true;
  }

  const byCode = profile.code && submission.coachCode
    ? normalize(submission.coachCode).includes(normalize(profile.code))
    : false;
  const byEmail = profile.email && submission.submitterEmail
    ? normalize(submission.submitterEmail).includes(normalize(profile.email))
    : false;
  const byName = profile.name && submission.coachName
    ? normalize(submission.coachName).includes(normalize(profile.name))
    : false;

  const hasCoachFields = Boolean(submission.coachCode || submission.submitterEmail || submission.coachName);
  if (!hasCoachFields) {
    return true;
  }
  return byCode || byEmail || byName;
}

async function listMessagesForAccount(
  config: AppConfig,
  account: GoogleAccountConfig,
  range?: { start?: string; end?: string },
): Promise<GmailSubmissionRecord[]> {
  if (!loadSavedTokens(account.tokenPath)) {
    return [];
  }

  const auth = createOAuthClient(config);
  auth.setCredentials(loadSavedTokens(account.tokenPath) ?? {});
  const gmail = google.gmail({ version: "v1", auth });

  const messages: GmailSubmissionRecord[] = [];
  let nextPageToken: string | undefined;

  for (let page = 0; page < 3; page += 1) {
    const listResponse = await gmail.users.messages.list({
      userId: "me",
      q: buildReceiptQuery(range),
      maxResults: 50,
      pageToken: nextPageToken,
    });

    const pageMessages = await Promise.all(
      (listResponse.data.messages ?? [])
        .filter((messageRef): messageRef is { id: string } => Boolean(messageRef.id))
        .map(async (messageRef) => {
          const message = await gmail.users.messages.get({
            userId: "me",
            id: messageRef.id,
            format: "full",
          });
          return parseSubmission(message.data, account);
        }),
    );
    messages.push(...pageMessages.filter((item): item is GmailSubmissionRecord => Boolean(item)));

    nextPageToken = listResponse.data.nextPageToken ?? undefined;
    if (!nextPageToken) {
      break;
    }
  }

  return messages;
}

export async function listGmailSubmissions(
  config: AppConfig,
  range?: { start?: string; end?: string },
): Promise<GmailSubmissionRecord[]> {
  const results = await Promise.all(
    config.googleAccounts.gmails.map((account) => listMessagesForAccount(config, account, range)),
  );

  return results
    .flat()
    .filter((submission) => matchesCoachProfile(config, submission))
    .filter((submission) => {
      const logicalDate = submissionLogicalDate(submission);
      const startDate = range?.start?.slice(0, 10);
      const endDate = range?.end?.slice(0, 10);
      if (startDate && logicalDate < startDate) {
        return false;
      }
      if (endDate && logicalDate > endDate) {
        return false;
      }
      return true;
    })
    .sort((left, right) => right.submittedAt.localeCompare(left.submittedAt));
}
