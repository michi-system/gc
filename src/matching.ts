import type { AnswerValue, FormType } from "./types.js";
import { normalizeLooseText, normalizeText } from "./utils.js";

function normalizeDate(value: string): string {
  const trimmed = normalizeText(value);
  const match = trimmed.match(/^(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})$/);
  if (!match) {
    return trimmed;
  }
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function normalizeTime(value: string): string {
  const trimmed = normalizeText(value);
  const match = trimmed.match(/^(\d{1,2}):(\d{1,2})$/);
  if (!match) {
    return trimmed;
  }
  return `${match[1].padStart(2, "0")}:${match[2].padStart(2, "0")}`;
}

function scalarText(value: AnswerValue | undefined): string {
  if (typeof value === "undefined") {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeText(entry)).join(" ");
  }
  if (typeof value === "string") {
    return normalizeText(value);
  }
  return normalizeText([value.date, value.time].filter(Boolean).join(" "));
}

function answerFor(answers: Record<string, AnswerValue>, title: string): AnswerValue | undefined {
  return answers[title] ?? answers[normalizeLooseText(title)] ?? answers[normalizeText(title)];
}

function dateOnly(value: AnswerValue | undefined): string {
  if (!value) {
    return "";
  }
  if (Array.isArray(value)) {
    return normalizeDate(value[0] ?? "");
  }
  if (typeof value === "string") {
    const match = normalizeText(value).match(/(\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2})/);
    return normalizeDate(match?.[1] ?? value);
  }
  return normalizeDate(value.date ?? "");
}

function dateTime(value: AnswerValue | undefined): string {
  if (!value) {
    return "";
  }
  if (Array.isArray(value)) {
    const [datePart, timePart] = value;
    return [normalizeDate(datePart ?? ""), normalizeTime(timePart ?? "")]
      .filter(Boolean)
      .join(" ")
      .trim();
  }
  if (typeof value === "string") {
    const normalized = normalizeText(value);
    const match = normalized.match(/(\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2})(?:\s+(\d{1,2}:\d{1,2}))?/);
    if (!match) {
      return normalized;
    }
    return [normalizeDate(match[1]), normalizeTime(match[2] ?? "")]
      .filter(Boolean)
      .join(" ")
      .trim();
  }
  return [normalizeDate(value.date ?? ""), normalizeTime(value.time ?? "")]
    .filter(Boolean)
    .join(" ")
    .trim();
}

export function matchGroupKeyForAnswers(formType: FormType, answers: Record<string, AnswerValue>): string {
  if (formType === "schedule_change") {
    const studentName = scalarText(
      answerFor(
        answers,
        "コーチング日程を変更する生徒さんのお名前を漢字で記入してください。\n※名字と名前の間に半角スペースを入れてください",
      ),
    );
    return `${studentName}:${dateTime(answerFor(answers, "調整前(通常時)のコーチング時間を教えてください。"))}:${dateTime(
      answerFor(answers, "変更後のコーチング時間を教えてください。"),
    )}`;
  }

  if (formType === "handoff") {
    return `${scalarText(answerFor(answers, "生徒コード"))}:${scalarText(answerFor(answers, "引き継ぎ項目"))}`;
  }

  if (formType === "work_report_non_coaching") {
    return `${dateOnly(answerFor(answers, "作業日時"))}:${scalarText(answerFor(
      answers,
      "コーチング以外の作業時間(時間:分)",
    ))}:${scalarText(answerFor(answers, "作業内容"))}:${scalarText(answerFor(answers, "業務依頼者"))}`;
  }

  return `${dateOnly(answerFor(answers, "作業日時"))}:${scalarText(answerFor(answers, "生徒コード"))}:${scalarText(
    answerFor(answers, "該当作業"),
  )}`;
}
