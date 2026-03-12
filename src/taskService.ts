import { randomUUID } from "node:crypto";

import { AppDatabase } from "./db.js";
import { FORM_CATALOG, HANDOFF_BODY_TITLES, HANDOFF_VALUE_BY_POLICY } from "./constants.js";
import { matchGroupKeyForAnswers } from "./matching.js";
import type {
  AppConfig,
  AnswerValue,
  CalendarSession,
  FormType,
  GmailSubmission,
  HandoffPolicy,
  RosterEntry,
  SyncSummary,
  TaskFieldSpec,
  TaskPayload,
  TaskRecord,
  TaskStatus,
} from "./types.js";
import {
  asString,
  durationToHoursMinutes,
  inferDateFromIso,
  inferTimeFromIso,
  isNonEmptyAnswer,
  normalizeText,
  nowIso,
} from "./utils.js";

function fillBaseWorkReportAnswers(config: AppConfig, taskType: "コーチング" | "コーチング以外", session: CalendarSession) {
  return {
    メールアドレス: config.coachProfile.email,
    お名前_漢字フルネーム: config.coachProfile.coachName,
    コーチコード: config.coachProfile.coachCode,
    作業日時: session.sessionDate,
    該当作業: taskType,
  } satisfies Record<string, AnswerValue>;
}

function missingFields(fieldSpecs: TaskFieldSpec[], answers: Record<string, AnswerValue>): string[] {
  return fieldSpecs
    .filter((field) => field.required)
    .filter((field) => !isNonEmptyAnswer(answers[field.title]))
    .map((field) => field.title);
}

function mergeAnswers(base: Record<string, AnswerValue>, existing?: Record<string, AnswerValue>) {
  return {
    ...base,
    ...existing,
  };
}

function buildPayload(fieldSpecs: TaskFieldSpec[], answers: Record<string, AnswerValue>, reviewHints: string[]): TaskPayload {
  return {
    fieldSpecs,
    answers,
    reviewHints,
  };
}

function coachingTask(session: CalendarSession, config: AppConfig): TaskRecord {
  const answers = {
    ...fillBaseWorkReportAnswers(config, "コーチング", session),
    生徒コード: session.studentCode ?? "",
    "生徒氏名(漢字フルネーム)": session.studentName ?? "",
    "コーチングの参加状況": "当日参加",
    今日の振り返り: ["コーチング通知botへ今日の面談を実施する連絡をしましたか？"],
  };
  const reviewHints: string[] = [];
  if (!session.studentName || !session.studentCode) {
    reviewHints.push("カレンダーの予定から生徒を特定できませんでした。Roster で補正してください。");
  }

  return {
    id: randomUUID(),
    formType: "work_report_coaching",
    formKey: FORM_CATALOG.work_report_coaching.formKey,
    status: "ready_to_open",
    derivedKey: `work:${session.id}`,
    matchGroupKey: matchGroupKeyForAnswers("work_report_coaching", answers),
    title: `${session.sessionDate} / 作業報告 / ${session.studentName ?? session.rawTitle}`,
    studentName: session.studentName,
    studentCode: session.studentCode,
    sessionDate: session.sessionDate,
    payload: buildPayload(FORM_CATALOG.work_report_coaching.fieldSpecs, answers, reviewHints),
    missingFields: missingFields(FORM_CATALOG.work_report_coaching.fieldSpecs, answers),
    sourceRefs: [{ kind: "calendar_event", label: "Calendar Event", value: session.id }],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function inferNonCoachingWorkContent(session: CalendarSession): string {
  const haystack = normalizeText(`${session.rawTitle} ${session.rawDescription}`);
  const options = FORM_CATALOG.work_report_non_coaching.fieldSpecs.find((field) => field.title === "作業内容")?.options ?? [];
  const matched = options.find((option) => haystack.includes(normalizeText(option).replace(/[()]/g, "")));
  return matched ?? "";
}

function inferRequester(session: CalendarSession): string {
  const haystack = normalizeText(`${session.rawTitle} ${session.rawDescription}`);
  const options = FORM_CATALOG.work_report_non_coaching.fieldSpecs.find((field) => field.title === "業務依頼者")?.options ?? [];
  return options.find((option) => option !== "研修" && haystack.includes(normalizeText(option))) ?? (haystack.includes("研修") ? "研修" : "");
}

function nonCoachingTask(session: CalendarSession, config: AppConfig): TaskRecord {
  const answers = {
    ...fillBaseWorkReportAnswers(config, "コーチング以外", session),
    "コーチング以外の作業時間(時間:分)": durationToHoursMinutes(session.startAt, session.endAt),
    作業内容: inferNonCoachingWorkContent(session),
    具体的な作業内容: "",
    業務依頼者: inferRequester(session),
  };

  const reviewHints = ["コーチング以外の詳細は送信前に確認してください。"];

  return {
    id: randomUUID(),
    formType: "work_report_non_coaching",
    formKey: FORM_CATALOG.work_report_non_coaching.formKey,
    status: "pending_enrichment",
    derivedKey: `work:${session.id}`,
    matchGroupKey: matchGroupKeyForAnswers("work_report_non_coaching", answers),
    title: `${session.sessionDate} / コーチング以外 / ${session.studentName ?? session.rawTitle}`,
    studentName: session.studentName,
    studentCode: session.studentCode,
    sessionDate: session.sessionDate,
    payload: buildPayload(FORM_CATALOG.work_report_non_coaching.fieldSpecs, answers, reviewHints),
    missingFields: missingFields(FORM_CATALOG.work_report_non_coaching.fieldSpecs, answers),
    sourceRefs: [{ kind: "calendar_event", label: "Calendar Event", value: session.id }],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function scheduleChangeTask(session: CalendarSession, config: AppConfig): TaskRecord {
  const beforeDate = session.originalStartAt ? inferDateFromIso(session.originalStartAt, config.timezone) : "";
  const beforeTime = session.originalStartAt ? inferTimeFromIso(session.originalStartAt, config.timezone) : "";
  const afterDate = inferDateFromIso(session.startAt, config.timezone);
  const afterTime = inferTimeFromIso(session.startAt, config.timezone);
  const today = inferDateFromIso(new Date().toISOString(), config.timezone);
  const reviewHints: string[] = [];

  if (session.sessionDate === today || beforeDate === today) {
    reviewHints.push("当日変更の可能性があります。PDFルールに従って手動確認してください。");
  }

  const answers = {
    メールアドレス: config.coachProfile.email,
    お名前: config.coachProfile.coachName,
    "コーチング日程を変更する生徒さんのお名前を漢字で記入してください。\n※名字と名前の間に半角スペースを入れてください":
      session.studentName ?? "",
    "調整前(通常時)のコーチング時間を教えてください。": {
      date: beforeDate,
      time: beforeTime,
    },
    "変更後のコーチング時間を教えてください。": {
      date: afterDate,
      time: afterTime,
    },
    "コーチングの日程変更理由を教えてください。": "",
    "【予定が入ってしまったを選んだ方への質問です】\n予定を教えてください。": "",
    "【代行を依頼する場合】\n代行をしてくださるコーチのお名前をご記入ください。": "",
  } satisfies Record<string, AnswerValue>;

  return {
    id: randomUUID(),
    formType: "schedule_change",
    formKey: FORM_CATALOG.schedule_change.formKey,
    status: reviewHints.length > 0 ? "manual_review" : "pending_enrichment",
    derivedKey: `schedule:${session.id}`,
    matchGroupKey: matchGroupKeyForAnswers("schedule_change", answers),
    title: `${session.sessionDate} / 日程変更 / ${session.studentName ?? session.rawTitle}`,
    studentName: session.studentName,
    studentCode: session.studentCode,
    sessionDate: session.sessionDate,
    payload: buildPayload(FORM_CATALOG.schedule_change.fieldSpecs, answers, reviewHints),
    missingFields: missingFields(FORM_CATALOG.schedule_change.fieldSpecs, answers),
    sourceRefs: [
      { kind: "calendar_event", label: "Calendar Event", value: session.id },
      { kind: "rule", label: "Rule", value: "single-day schedule changes only" },
    ],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function handoffFieldSpecs(policy: HandoffPolicy): TaskFieldSpec[] {
  const bodyTitle =
    policy === "advance_premium"
      ? HANDOFF_BODY_TITLES.advance_premium
      : policy === "coach_change"
        ? HANDOFF_BODY_TITLES.coach_change
        : HANDOFF_BODY_TITLES.substitute;

  return [
    ...FORM_CATALOG.handoff.fieldSpecs,
    { title: bodyTitle, kind: "textarea", required: true },
  ];
}

function handoffTask(session: CalendarSession, config: AppConfig, roster: RosterEntry): TaskRecord {
  const policy = roster.handoffPolicy;
  const handoffValue = HANDOFF_VALUE_BY_POLICY[policy as Exclude<HandoffPolicy, "none">];
  const bodyTitle =
    policy === "advance_premium"
      ? HANDOFF_BODY_TITLES.advance_premium
      : policy === "coach_change"
        ? HANDOFF_BODY_TITLES.coach_change
        : HANDOFF_BODY_TITLES.substitute;
  const answers = {
    メールアドレス: config.coachProfile.email,
    お名前_漢字フルネーム: config.coachProfile.coachName,
    コーチコード: config.coachProfile.coachCode,
    "生徒氏名(漢字フルネーム)": session.studentName ?? roster.studentName,
    生徒コード: session.studentCode ?? roster.studentCode,
    引き継ぎ項目: handoffValue,
    [bodyTitle]: "",
  } satisfies Record<string, AnswerValue>;

  return {
    id: randomUUID(),
    formType: "handoff",
    formKey: FORM_CATALOG.handoff.formKey,
    status: "pending_enrichment",
    derivedKey: `handoff:${session.id}`,
    matchGroupKey: matchGroupKeyForAnswers("handoff", answers),
    title: `${session.sessionDate} / 引き継ぎ / ${session.studentName ?? roster.studentName}`,
    studentName: session.studentName ?? roster.studentName,
    studentCode: session.studentCode ?? roster.studentCode,
    sessionDate: session.sessionDate,
    payload: buildPayload(handoffFieldSpecs(policy), answers, ["引き継ぎ本文を確認してからフォームを開いてください。"]),
    missingFields: missingFields(handoffFieldSpecs(policy), answers),
    sourceRefs: [{ kind: "calendar_event", label: "Calendar Event", value: session.id }],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function deriveCandidateTasks(sessions: CalendarSession[], config: AppConfig, roster: RosterEntry[]): TaskRecord[] {
  const rosterByCode = new Map(roster.map((entry) => [entry.studentCode, entry]));
  const tasks: TaskRecord[] = [];

  sessions.forEach((session) => {
    if (session.taskType === "coaching") {
      tasks.push(coachingTask(session, config));

      const rosterEntry = session.studentCode ? rosterByCode.get(session.studentCode) : undefined;
      if (rosterEntry && rosterEntry.handoffPolicy !== "none") {
        tasks.push(handoffTask(session, config, rosterEntry));
      }
    } else {
      tasks.push(nonCoachingTask(session, config));
    }

    if (session.recurringEventId && session.originalStartAt && session.originalStartAt !== session.startAt) {
      tasks.push(scheduleChangeTask(session, config));
    }
  });

  return tasks;
}

function applySubmissionMatches(tasks: TaskRecord[], submissions: GmailSubmission[]): Map<string, GmailSubmission> {
  const matched = new Map<string, GmailSubmission>();
  const taskGroups = new Map<string, TaskRecord[]>();
  const submissionGroups = new Map<string, GmailSubmission[]>();

  tasks.forEach((task) => {
    const key = `${task.formType}:${task.matchGroupKey}`;
    const current = taskGroups.get(key) ?? [];
    current.push(task);
    taskGroups.set(key, current);
  });

  submissions.forEach((submission) => {
    const key = `${submission.formType}:${submission.matchGroupKey}`;
    const current = submissionGroups.get(key) ?? [];
    current.push(submission);
    submissionGroups.set(key, current);
  });

  taskGroups.forEach((groupTasks, key) => {
    const groupSubmissions = submissionGroups.get(key) ?? [];
    groupTasks.sort((left, right) => `${left.sessionDate ?? ""}:${left.derivedKey}`.localeCompare(`${right.sessionDate ?? ""}:${right.derivedKey}`));
    groupSubmissions.sort((left, right) => left.submittedAt.localeCompare(right.submittedAt));

    groupTasks.forEach((task, index) => {
      const submission = groupSubmissions[index];
      if (submission) {
        matched.set(task.derivedKey, submission);
      }
    });
  });

  return matched;
}

function recomputeStatus(task: TaskRecord, matchedSubmission: GmailSubmission | undefined, existing: TaskRecord | null): TaskStatus {
  if (matchedSubmission) {
    return "submitted_confirmed";
  }

  if (task.payload.reviewHints.some((hint) => hint.includes("手動確認"))) {
    return "manual_review";
  }

  if (task.missingFields.length > 0) {
    return "pending_enrichment";
  }

  if (existing?.status === "awaiting_user_submit") {
    return "awaiting_user_submit";
  }

  if (existing?.status === "error") {
    return "error";
  }

  return "ready_to_open";
}

function mergeWithExisting(task: TaskRecord, existing: TaskRecord | null): TaskRecord {
  if (!existing) {
    const nextStatus =
      task.payload.reviewHints.some((hint) => hint.includes("手動確認"))
        ? "manual_review"
        : task.missingFields.length > 0
          ? "pending_enrichment"
          : "ready_to_open";
    return {
      ...task,
      status: nextStatus,
    };
  }

  const mergedAnswers = mergeAnswers(task.payload.answers, existing.payload.answers);
  const payload = {
    ...task.payload,
    answers: mergedAnswers,
  };
  const nextMissingFields = missingFields(payload.fieldSpecs, mergedAnswers);

  return {
    ...task,
    id: existing.id,
    claimedAt: existing.claimedAt,
    createdAt: existing.createdAt,
    matchGroupKey: matchGroupKeyForAnswers(task.formType, mergedAnswers),
    payload,
    missingFields: nextMissingFields,
    lastError: existing.lastError,
  };
}

export function buildTasks(
  sessions: CalendarSession[],
  submissions: GmailSubmission[],
  config: AppConfig,
  roster: RosterEntry[],
  db: AppDatabase,
): TaskRecord[] {
  const candidates = deriveCandidateTasks(sessions, config, roster).map((task) => mergeWithExisting(task, db.getTaskByDerivedKey(task.derivedKey)));
  const matchedSubmissions = applySubmissionMatches(candidates, submissions);

  return candidates.map((candidate) => {
    const existing = db.getTaskByDerivedKey(candidate.derivedKey);
    const submission = matchedSubmissions.get(candidate.derivedKey);
    return {
      ...candidate,
      status: recomputeStatus(candidate, submission, existing),
      updatedAt: nowIso(),
      lastError: submission ? null : candidate.lastError ?? null,
    };
  });
}

export function buildSyncSummary(db: AppDatabase, sessionsFetched: number, submissionsFetched: number, rosterSynced: number, tasksUpserted: number): SyncSummary {
  return {
    sessionsFetched,
    submissionsFetched,
    rosterSynced,
    tasksUpserted,
    taskCountsByStatus: db.countTasksByStatus(),
  };
}

export function enrichTask(task: TaskRecord, patch: Record<string, AnswerValue>): TaskRecord {
  const nextAnswers = {
    ...task.payload.answers,
    ...patch,
  };
  const nextPayload: TaskPayload = {
    ...task.payload,
    answers: nextAnswers,
  };
  const nextMissingFields = missingFields(nextPayload.fieldSpecs, nextAnswers);
  const nextStatus: TaskStatus = nextMissingFields.length > 0 ? "pending_enrichment" : "ready_to_open";

  return {
    ...task,
    payload: nextPayload,
    missingFields: nextMissingFields,
    status: nextStatus,
    lastError: null,
    updatedAt: nowIso(),
  };
}

export function openableTask(task: TaskRecord): boolean {
  return task.status !== "manual_review" && task.status !== "submitted_confirmed" && task.missingFields.length === 0;
}

export function describeAudit(db: AppDatabase) {
  const tasks = db.listTasks();
  const submissions = db.listGmailSubmissions();
  const sessions = db.listCalendarSessions();
  const roster = db.listRoster();

  return {
    counts: {
      tasks: tasks.length,
      submissions: submissions.length,
      sessions: sessions.length,
      roster: roster.length,
    },
    taskCountsByStatus: db.countTasksByStatus(),
    taskCountsByFormType: tasks.reduce<Record<FormType, number>>(
      (accumulator, task) => {
        accumulator[task.formType] += 1;
        return accumulator;
      },
      {
        work_report_coaching: 0,
        work_report_non_coaching: 0,
        schedule_change: 0,
        handoff: 0,
      },
    ),
    awaitingUserSubmit: tasks.filter((task) => task.status === "awaiting_user_submit"),
    unresolvedErrors: tasks.filter((task) => task.status === "error"),
  };
}
