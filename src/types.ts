export type TaskStatus =
  | "pending_enrichment"
  | "ready_to_open"
  | "awaiting_user_submit"
  | "submitted_confirmed"
  | "manual_review"
  | "error";

export type FormType =
  | "work_report_coaching"
  | "work_report_non_coaching"
  | "schedule_change"
  | "handoff";

export type FormKey = "work_report" | "schedule_change" | "handoff";

export type HandoffPolicy = "none" | "advance_premium" | "coach_change" | "substitute";

export type DefaultTaskType = "coaching" | "teaching" | "other";

export type FieldKind =
  | "text"
  | "textarea"
  | "radio"
  | "checkbox"
  | "dropdown"
  | "date"
  | "time"
  | "dateTime"
  | "duration";

export type AnswerValue =
  | string
  | string[]
  | {
      date?: string;
      time?: string;
    };

export interface TaskFieldSpec {
  title: string;
  kind: FieldKind;
  required: boolean;
  helpText?: string;
  options?: string[];
}

export interface SourceRef {
  kind: "calendar_event" | "gmail_message" | "sheet_row" | "rule";
  label: string;
  value: string;
}

export interface TaskPayload {
  answers: Record<string, AnswerValue>;
  fieldSpecs: TaskFieldSpec[];
  reviewHints: string[];
}

export interface TaskRecord {
  id: string;
  formType: FormType;
  formKey: FormKey;
  status: TaskStatus;
  derivedKey: string;
  matchGroupKey: string;
  title: string;
  studentName?: string;
  studentCode?: string;
  sessionDate?: string;
  payload: TaskPayload;
  missingFields: string[];
  sourceRefs: SourceRef[];
  lastError?: string | null;
  claimedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CoachProfile {
  coachName: string;
  coachCode: string;
  email: string;
}

export interface AppConfig {
  timezone: string;
  syncWindowDays: number;
  coachProfile: CoachProfile;
  googleOAuth: {
    clientCredentialsPath: string;
  };
  calendars: {
    selectedCalendarIds: string[];
  };
  gmail: {
    queries: Record<FormKey, string>;
  };
  sheets: {
    spreadsheetId: string;
    sheetName: string;
    headerRow: number;
    studentNameColumn: string;
    studentCodeColumn: string;
  };
}

export interface RosterEntry {
  studentName: string;
  studentCode: string;
  aliases: string[];
  calendarMatchPattern: string;
  handoffPolicy: HandoffPolicy;
  defaultTaskType: DefaultTaskType;
  manualOnly: boolean;
  updatedAt: string;
}

export interface CalendarSession {
  id: string;
  recurringEventId?: string | null;
  originalStartAt?: string | null;
  startAt: string;
  endAt: string;
  sessionDate: string;
  studentName?: string;
  studentCode?: string;
  taskType: DefaultTaskType;
  rawTitle: string;
  rawDescription: string;
  calendarId: string;
  sourceJson: Record<string, unknown>;
}

export interface GmailSubmission {
  messageId: string;
  formType: FormType;
  formKey: FormKey;
  subject: string;
  submittedAt: string;
  matchGroupKey: string;
  answers: Record<string, AnswerValue>;
  rawBody: string;
}

export interface CalendarChoice {
  id: string;
  summary: string;
  primary?: boolean;
}

export interface SyncSummary {
  sessionsFetched: number;
  submissionsFetched: number;
  rosterSynced: number;
  tasksUpserted: number;
  taskCountsByStatus: Record<TaskStatus, number>;
}

export interface FormFieldDefinition {
  entryId: number;
  title: string;
  typeCode: number;
  options: string[];
  helpText?: string;
}

export interface FormDefinition {
  title: string;
  items: FormFieldDefinition[];
}
