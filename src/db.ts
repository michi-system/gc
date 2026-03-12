import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { DEFAULT_CONFIG, DEFAULT_DB_PATH } from "./constants.js";
import type {
  AppConfig,
  CalendarSession,
  GmailSubmission,
  RosterEntry,
  TaskRecord,
  TaskStatus,
} from "./types.js";
import { nowIso } from "./utils.js";

function jsonParse<T>(value: string | null, fallback: T): T {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class AppDatabase {
  readonly sqlite: Database.Database;

  private rowToTask(row: Record<string, unknown>): TaskRecord {
    return {
      id: String(row.id),
      formType: String(row.form_type) as TaskRecord["formType"],
      formKey: String(row.form_key) as TaskRecord["formKey"],
      status: String(row.status) as TaskStatus,
      derivedKey: String(row.derived_key),
      matchGroupKey: String(row.match_group_key),
      title: String(row.title),
      studentName: row.student_name ? String(row.student_name) : undefined,
      studentCode: row.student_code ? String(row.student_code) : undefined,
      sessionDate: row.session_date ? String(row.session_date) : undefined,
      payload: jsonParse<TaskRecord["payload"]>(String(row.payload_json), { answers: {}, fieldSpecs: [], reviewHints: [] }),
      missingFields: jsonParse<string[]>(String(row.missing_fields_json), []),
      sourceRefs: jsonParse<TaskRecord["sourceRefs"]>(String(row.source_refs_json), []),
      lastError: row.last_error ? String(row.last_error) : null,
      claimedAt: row.claimed_at ? String(row.claimed_at) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  constructor(dbPath = DEFAULT_DB_PATH) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.sqlite = new Database(dbPath);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS roster (
        student_code TEXT PRIMARY KEY,
        student_name TEXT NOT NULL,
        aliases_json TEXT NOT NULL,
        calendar_match_pattern TEXT NOT NULL,
        handoff_policy TEXT NOT NULL,
        default_task_type TEXT NOT NULL,
        manual_only INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS calendar_sessions (
        id TEXT PRIMARY KEY,
        session_date TEXT NOT NULL,
        student_code TEXT,
        data_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS gmail_submissions (
        message_id TEXT PRIMARY KEY,
        form_type TEXT NOT NULL,
        match_group_key TEXT NOT NULL,
        submitted_at TEXT NOT NULL,
        data_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        form_type TEXT NOT NULL,
        form_key TEXT NOT NULL,
        status TEXT NOT NULL,
        derived_key TEXT NOT NULL UNIQUE,
        match_group_key TEXT NOT NULL,
        title TEXT NOT NULL,
        student_name TEXT,
        student_code TEXT,
        session_date TEXT,
        payload_json TEXT NOT NULL,
        missing_fields_json TEXT NOT NULL,
        source_refs_json TEXT NOT NULL,
        last_error TEXT,
        claimed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  loadConfig(): AppConfig {
    const row = this.sqlite.prepare("SELECT value FROM settings WHERE key = ?").get("app_config") as { value?: string } | undefined;
    const persisted = row?.value ? jsonParse<Partial<AppConfig>>(row.value, {}) : {};

    return {
      ...DEFAULT_CONFIG,
      ...persisted,
      coachProfile: {
        ...DEFAULT_CONFIG.coachProfile,
        ...persisted.coachProfile,
      },
      googleOAuth: {
        ...DEFAULT_CONFIG.googleOAuth,
        ...persisted.googleOAuth,
      },
      calendars: {
        ...DEFAULT_CONFIG.calendars,
        ...persisted.calendars,
      },
      gmail: {
        ...DEFAULT_CONFIG.gmail,
        ...persisted.gmail,
        queries: {
          ...DEFAULT_CONFIG.gmail.queries,
          ...persisted.gmail?.queries,
        },
      },
      sheets: {
        ...DEFAULT_CONFIG.sheets,
        ...persisted.sheets,
      },
    };
  }

  saveConfig(config: AppConfig): void {
    this.sqlite
      .prepare(
        `
          INSERT INTO settings (key, value)
          VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `,
      )
      .run("app_config", JSON.stringify(config));
  }

  listRoster(): RosterEntry[] {
    const rows = this.sqlite
      .prepare(
        `
          SELECT
            student_code,
            student_name,
            aliases_json,
            calendar_match_pattern,
            handoff_policy,
            default_task_type,
            manual_only,
            updated_at
          FROM roster
          ORDER BY student_name ASC
        `,
      )
      .all() as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      studentCode: String(row.student_code),
      studentName: String(row.student_name),
      aliases: jsonParse<string[]>(String(row.aliases_json), []),
      calendarMatchPattern: String(row.calendar_match_pattern ?? ""),
      handoffPolicy: String(row.handoff_policy) as RosterEntry["handoffPolicy"],
      defaultTaskType: String(row.default_task_type) as RosterEntry["defaultTaskType"],
      manualOnly: Boolean(row.manual_only),
      updatedAt: String(row.updated_at),
    }));
  }

  upsertRosterEntries(entries: RosterEntry[]): void {
    const statement = this.sqlite.prepare(`
      INSERT INTO roster (
        student_code,
        student_name,
        aliases_json,
        calendar_match_pattern,
        handoff_policy,
        default_task_type,
        manual_only,
        updated_at
      )
      VALUES (
        @studentCode,
        @studentName,
        @aliasesJson,
        @calendarMatchPattern,
        @handoffPolicy,
        @defaultTaskType,
        @manualOnly,
        @updatedAt
      )
      ON CONFLICT(student_code) DO UPDATE SET
        student_name = excluded.student_name,
        aliases_json = excluded.aliases_json,
        calendar_match_pattern = excluded.calendar_match_pattern,
        handoff_policy = excluded.handoff_policy,
        default_task_type = excluded.default_task_type,
        manual_only = excluded.manual_only,
        updated_at = excluded.updated_at
    `);

    const transaction = this.sqlite.transaction((batch: RosterEntry[]) => {
      batch.forEach((entry) => {
        statement.run({
          studentCode: entry.studentCode,
          studentName: entry.studentName,
          aliasesJson: JSON.stringify(entry.aliases),
          calendarMatchPattern: entry.calendarMatchPattern,
          handoffPolicy: entry.handoffPolicy,
          defaultTaskType: entry.defaultTaskType,
          manualOnly: entry.manualOnly ? 1 : 0,
          updatedAt: entry.updatedAt,
        });
      });
    });

    transaction(entries);
  }

  upsertCalendarSessions(entries: CalendarSession[]): void {
    const statement = this.sqlite.prepare(`
      INSERT INTO calendar_sessions (
        id,
        session_date,
        student_code,
        data_json,
        updated_at
      )
      VALUES (
        @id,
        @sessionDate,
        @studentCode,
        @dataJson,
        @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        session_date = excluded.session_date,
        student_code = excluded.student_code,
        data_json = excluded.data_json,
        updated_at = excluded.updated_at
    `);

    const transaction = this.sqlite.transaction((batch: CalendarSession[]) => {
      batch.forEach((entry) => {
        statement.run({
          id: entry.id,
          sessionDate: entry.sessionDate,
          studentCode: entry.studentCode ?? null,
          dataJson: JSON.stringify(entry),
          updatedAt: nowIso(),
        });
      });
    });

    transaction(entries);
  }

  listCalendarSessions(): CalendarSession[] {
    const rows = this.sqlite
      .prepare("SELECT data_json FROM calendar_sessions ORDER BY session_date ASC, id ASC")
      .all() as Array<{ data_json: string }>;

    return rows.map((row) => jsonParse<CalendarSession>(row.data_json, {} as CalendarSession));
  }

  upsertGmailSubmissions(entries: GmailSubmission[]): void {
    const statement = this.sqlite.prepare(`
      INSERT INTO gmail_submissions (
        message_id,
        form_type,
        match_group_key,
        submitted_at,
        data_json,
        updated_at
      )
      VALUES (
        @messageId,
        @formType,
        @matchGroupKey,
        @submittedAt,
        @dataJson,
        @updatedAt
      )
      ON CONFLICT(message_id) DO UPDATE SET
        form_type = excluded.form_type,
        match_group_key = excluded.match_group_key,
        submitted_at = excluded.submitted_at,
        data_json = excluded.data_json,
        updated_at = excluded.updated_at
    `);

    const transaction = this.sqlite.transaction((batch: GmailSubmission[]) => {
      batch.forEach((entry) => {
        statement.run({
          messageId: entry.messageId,
          formType: entry.formType,
          matchGroupKey: entry.matchGroupKey,
          submittedAt: entry.submittedAt,
          dataJson: JSON.stringify(entry),
          updatedAt: nowIso(),
        });
      });
    });

    transaction(entries);
  }

  listGmailSubmissions(): GmailSubmission[] {
    const rows = this.sqlite
      .prepare("SELECT data_json FROM gmail_submissions ORDER BY submitted_at ASC")
      .all() as Array<{ data_json: string }>;

    return rows.map((row) => jsonParse<GmailSubmission>(row.data_json, {} as GmailSubmission));
  }

  listTasks(status?: TaskStatus): TaskRecord[] {
    const rows = (
      status
        ? this.sqlite.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC").all(status)
        : this.sqlite.prepare("SELECT * FROM tasks ORDER BY created_at DESC").all()
    ) as Array<Record<string, unknown>>;

    return rows.map((row) => this.rowToTask(row));
  }

  getTaskById(taskId: string): TaskRecord | null {
    const row = this.sqlite.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return this.rowToTask(row);
  }

  getTaskByDerivedKey(derivedKey: string): TaskRecord | null {
    const row = this.sqlite.prepare("SELECT * FROM tasks WHERE derived_key = ?").get(derivedKey) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return this.rowToTask(row);
  }

  upsertTasks(tasks: TaskRecord[]): void {
    const statement = this.sqlite.prepare(`
      INSERT INTO tasks (
        id,
        form_type,
        form_key,
        status,
        derived_key,
        match_group_key,
        title,
        student_name,
        student_code,
        session_date,
        payload_json,
        missing_fields_json,
        source_refs_json,
        last_error,
        claimed_at,
        created_at,
        updated_at
      )
      VALUES (
        @id,
        @formType,
        @formKey,
        @status,
        @derivedKey,
        @matchGroupKey,
        @title,
        @studentName,
        @studentCode,
        @sessionDate,
        @payloadJson,
        @missingFieldsJson,
        @sourceRefsJson,
        @lastError,
        @claimedAt,
        @createdAt,
        @updatedAt
      )
      ON CONFLICT(derived_key) DO UPDATE SET
        form_type = excluded.form_type,
        form_key = excluded.form_key,
        status = excluded.status,
        match_group_key = excluded.match_group_key,
        title = excluded.title,
        student_name = excluded.student_name,
        student_code = excluded.student_code,
        session_date = excluded.session_date,
        payload_json = excluded.payload_json,
        missing_fields_json = excluded.missing_fields_json,
        source_refs_json = excluded.source_refs_json,
        last_error = excluded.last_error,
        claimed_at = excluded.claimed_at,
        updated_at = excluded.updated_at
    `);

    const transaction = this.sqlite.transaction((batch: TaskRecord[]) => {
      batch.forEach((task) => {
        statement.run({
          id: task.id,
          formType: task.formType,
          formKey: task.formKey,
          status: task.status,
          derivedKey: task.derivedKey,
          matchGroupKey: task.matchGroupKey,
          title: task.title,
          studentName: task.studentName ?? null,
          studentCode: task.studentCode ?? null,
          sessionDate: task.sessionDate ?? null,
          payloadJson: JSON.stringify(task.payload),
          missingFieldsJson: JSON.stringify(task.missingFields),
          sourceRefsJson: JSON.stringify(task.sourceRefs),
          lastError: task.lastError ?? null,
          claimedAt: task.claimedAt ?? null,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
        });
      });
    });

    transaction(tasks);
  }

  updateTask(taskId: string, patch: Partial<TaskRecord>): TaskRecord | null {
    const existing = this.getTaskById(taskId);
    if (!existing) {
      return null;
    }

    const next: TaskRecord = {
      ...existing,
      ...patch,
      payload: patch.payload ?? existing.payload,
      sourceRefs: patch.sourceRefs ?? existing.sourceRefs,
      missingFields: patch.missingFields ?? existing.missingFields,
      updatedAt: nowIso(),
    };
    this.upsertTasks([next]);
    return next;
  }

  countTasksByStatus(): Record<TaskStatus, number> {
    const rows = this.sqlite
      .prepare("SELECT status, COUNT(*) AS count FROM tasks GROUP BY status")
      .all() as Array<{ status: TaskStatus; count: number }>;

    const counts: Record<TaskStatus, number> = {
      pending_enrichment: 0,
      ready_to_open: 0,
      awaiting_user_submit: 0,
      submitted_confirmed: 0,
      manual_review: 0,
      error: 0,
    };

    rows.forEach((row) => {
      counts[row.status] = row.count;
    });
    return counts;
  }
}
