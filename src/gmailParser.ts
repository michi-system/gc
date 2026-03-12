import type { GmailSubmission, FormType, FormKey, AnswerValue } from "./types.js";
import { FORM_CATALOG, FORM_TITLES, HANDOFF_BODY_TITLES } from "./constants.js";
import { matchGroupKeyForAnswers } from "./matching.js";
import { normalizeLooseText, normalizeText, titlePattern } from "./utils.js";

export interface GmailLikeMessage {
  id: string;
  subject: string;
  internalDate: string;
  body: string;
}

function orderedFieldTitlesForFormType(formType: FormType): string[] {
  if (formType === "handoff") {
    return [
      "メールアドレス",
      "お名前_漢字フルネーム",
      "コーチコード",
      "生徒氏名(漢字フルネーム)",
      "生徒コード",
      "引き継ぎ項目",
      HANDOFF_BODY_TITLES.advance_premium,
      HANDOFF_BODY_TITLES.coach_change,
      HANDOFF_BODY_TITLES.substitute,
    ];
  }

  return FORM_CATALOG[formType].fieldSpecs.map((field) => field.title);
}

function detectFormKey(subject: string, body: string): FormKey | null {
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

function extractOrderedAnswers(body: string, titles: string[]): Record<string, string> {
  const matches: Array<{ title: string; start: number; end: number }> = [];
  let cursor = 0;

  for (const title of titles) {
    const slice = body.slice(cursor);
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
    const nextStart = matches[index + 1]?.start ?? body.length;
    const rawValue = body.slice(match.end, nextStart);
    const cleaned = rawValue
      .replace(/^[\s:：-]+/, "")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/Google フォーム[\s\S]*$/i, "")
      .trim();

    if (cleaned.length > 0) {
      answers[normalizeLooseText(match.title)] = cleaned;
    }
  });

  return answers;
}

function parseAnswerValue(rawValue: string): AnswerValue {
  const normalized = rawValue.trim();
  if (normalized.includes("\n")) {
    const lines = normalized
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length > 1) {
      return lines;
    }
  }
  return normalized;
}

function parseWorkReportType(answers: Record<string, string>): FormType {
  const taskType = answers[normalizeLooseText("該当作業")] ?? "";
  return normalizeText(taskType) === "コーチング以外" ? "work_report_non_coaching" : "work_report_coaching";
}

function parseFormType(formKey: FormKey, answers: Record<string, string>): FormType {
  if (formKey === "schedule_change") {
    return "schedule_change";
  }
  if (formKey === "handoff") {
    return "handoff";
  }
  return parseWorkReportType(answers);
}

export function parseGmailSubmission(message: GmailLikeMessage): GmailSubmission | null {
  const formKey = detectFormKey(message.subject, message.body);
  if (!formKey) {
    return null;
  }

  const fallbackFormType = formKey === "work_report" ? "work_report_coaching" : formKey;
  const initialAnswers = extractOrderedAnswers(message.body, orderedFieldTitlesForFormType(fallbackFormType as FormType));
  const formType = parseFormType(formKey, initialAnswers);
  const answers = extractOrderedAnswers(message.body, orderedFieldTitlesForFormType(formType));

  const parsedAnswers: Record<string, AnswerValue> = {};
  Object.entries(answers).forEach(([title, value]) => {
    parsedAnswers[title] = parseAnswerValue(value);
  });

  return {
    messageId: message.id,
    formType,
    formKey,
    subject: message.subject,
    submittedAt: new Date(Number(message.internalDate)).toISOString(),
    matchGroupKey: matchGroupKeyForAnswers(formType, parsedAnswers),
    answers: parsedAnswers,
    rawBody: message.body,
  };
}
