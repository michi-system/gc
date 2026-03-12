import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, HANDOFF_BODY_TITLES, HANDOFF_VALUE_BY_POLICY } from "../src/constants.js";
import { AppDatabase } from "../src/db.js";
import { matchGroupKeyForAnswers } from "../src/matching.js";
import { buildTasks, enrichTask } from "../src/taskService.js";
import type { AppConfig, CalendarSession, GmailSubmission, RosterEntry } from "../src/types.js";

function config(): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    coachProfile: {
      coachName: "預忠道",
      coachCode: "gco0491",
      email: "coach@example.com",
    },
  };
}

function rosterEntry(overrides: Partial<RosterEntry> = {}): RosterEntry {
  return {
    studentName: "山田 太郎",
    studentCode: "ST001",
    aliases: [],
    calendarMatchPattern: "",
    handoffPolicy: "none",
    defaultTaskType: "coaching",
    manualOnly: false,
    updatedAt: "2026-03-12T00:00:00.000Z",
    ...overrides,
  };
}

function session(overrides: Partial<CalendarSession> = {}): CalendarSession {
  return {
    id: "session-1",
    recurringEventId: null,
    originalStartAt: null,
    startAt: "2026-03-12T09:00:00+09:00",
    endAt: "2026-03-12T10:00:00+09:00",
    sessionDate: "2026-03-12",
    studentName: "山田 太郎",
    studentCode: "ST001",
    taskType: "coaching",
    rawTitle: "山田 太郎 コーチング",
    rawDescription: "",
    calendarId: "cal-1",
    sourceJson: {},
    ...overrides,
  };
}

describe("buildTasks", () => {
  it("leaves one coaching task pending when only one of two submissions exists", () => {
    const db = new AppDatabase(":memory:");
    const sessions = [
      session({ id: "session-a", startAt: "2026-03-12T09:00:00+09:00", endAt: "2026-03-12T10:00:00+09:00" }),
      session({ id: "session-b", startAt: "2026-03-12T11:00:00+09:00", endAt: "2026-03-12T12:00:00+09:00" }),
    ];

    const submission: GmailSubmission = {
      messageId: "gmail-1",
      formType: "work_report_coaching",
      formKey: "work_report",
      subject: "作業時間報告-2025年度 の回答",
      submittedAt: "2026-03-12T15:00:00.000Z",
      matchGroupKey: "2026-03-12:ST001:コーチング",
      answers: {
        作業日時: "2026-03-12",
        生徒コード: "ST001",
        該当作業: "コーチング",
      },
      rawBody: "",
    };

    const tasks = buildTasks(sessions, [submission], config(), [rosterEntry()], db).filter((task) => task.formType === "work_report_coaching");
    expect(tasks).toHaveLength(2);
    expect(tasks.filter((task) => task.status === "submitted_confirmed")).toHaveLength(1);
    expect(tasks.filter((task) => task.status === "ready_to_open")).toHaveLength(1);
  });

  it("creates a schedule change only for single moved occurrences", () => {
    const db = new AppDatabase(":memory:");
    const tasks = buildTasks(
      [
        session({
          id: "moved",
          recurringEventId: "series-1",
          originalStartAt: "2026-03-20T18:00:00+09:00",
          startAt: "2026-03-21T19:30:00+09:00",
          endAt: "2026-03-21T20:30:00+09:00",
          sessionDate: "2026-03-21",
        }),
        session({
          id: "fixed",
          recurringEventId: "series-2",
          originalStartAt: null,
          startAt: "2026-03-27T19:30:00+09:00",
          endAt: "2026-03-27T20:30:00+09:00",
          sessionDate: "2026-03-27",
        }),
      ],
      [],
      config(),
      [rosterEntry()],
      db,
    );

    const scheduleTasks = tasks.filter((task) => task.formType === "schedule_change");
    expect(scheduleTasks).toHaveLength(1);
    expect(scheduleTasks[0].status).toBe("pending_enrichment");
  });

  it("creates handoff tasks only for roster entries with a handoff policy", () => {
    const db = new AppDatabase(":memory:");
    const roster = [
      rosterEntry({ studentName: "山田 太郎", studentCode: "ST001", handoffPolicy: "advance_premium" }),
      rosterEntry({ studentName: "佐藤 花子", studentCode: "ST002", handoffPolicy: "none" }),
    ];

    const tasks = buildTasks(
      [
        session({ id: "advance", studentName: "山田 太郎", studentCode: "ST001" }),
        session({ id: "normal", studentName: "佐藤 花子", studentCode: "ST002", rawTitle: "佐藤 花子 コーチング" }),
      ],
      [],
      config(),
      roster,
      db,
    );

    const handoffTasks = tasks.filter((task) => task.formType === "handoff");
    expect(handoffTasks).toHaveLength(1);
    expect(handoffTasks[0].payload.answers["引き継ぎ項目"]).toBe(HANDOFF_VALUE_BY_POLICY.advance_premium);
    expect(handoffTasks[0].missingFields).toContain(HANDOFF_BODY_TITLES.advance_premium);
  });

  it("keeps non-coaching tasks in pending enrichment until the free-text detail is filled", () => {
    const db = new AppDatabase(":memory:");
    const tasks = buildTasks(
      [
        session({
          id: "other-work",
          taskType: "other",
          rawTitle: "研修/研修動画視聴",
          rawDescription: "研修",
          studentName: undefined,
          studentCode: undefined,
        }),
      ],
      [],
      config(),
      [],
      db,
    );

    const task = tasks.find((entry) => entry.formType === "work_report_non_coaching");
    expect(task?.status).toBe("pending_enrichment");
    expect(task?.missingFields).toContain("具体的な作業内容");
  });

  it("recomputes non-coaching match keys from enriched answers so Gmail confirmation can match later", () => {
    const db = new AppDatabase(":memory:");
    const sessions = [
      session({
        id: "non-coaching",
        taskType: "other",
        rawTitle: "研修/研修動画視聴",
        rawDescription: "研修",
        studentName: undefined,
        studentCode: undefined,
      }),
    ];

    const initialTasks = buildTasks(sessions, [], config(), [], db);
    const original = initialTasks.find((entry) => entry.formType === "work_report_non_coaching");
    expect(original).toBeDefined();
    db.upsertTasks(initialTasks);

    const enriched = enrichTask(original!, {
      作業内容: "研修/研修動画視聴",
      具体的な作業内容: "初回コーチング動画を視聴",
      業務依頼者: "研修",
    });
    db.updateTask(enriched.id, enriched);

    const resynced = buildTasks(
      sessions,
      [
        {
          messageId: "gmail-non-coaching",
          formType: "work_report_non_coaching",
          formKey: "work_report",
          subject: "作業時間報告-2025年度 の回答",
          submittedAt: "2026-03-12T14:00:00.000Z",
          matchGroupKey: matchGroupKeyForAnswers("work_report_non_coaching", enriched.payload.answers),
          answers: enriched.payload.answers,
          rawBody: "",
        },
      ],
      config(),
      [],
      db,
    );

    const matched = resynced.find((entry) => entry.id === enriched.id);
    expect(matched?.status).toBe("submitted_confirmed");
  });
});
