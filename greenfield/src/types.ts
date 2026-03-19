export type GoogleAuthPurpose = "login" | "gmail" | "calendar";

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  picture?: string;
}

export interface GoogleAccountConfig {
  id: string;
  email: string;
  tokenPath: string;
}

export interface AppConfig {
  timezone: string;
  coachProfile: {
    name: string;
    code: string;
    email: string;
  };
  googleOAuth: {
    clientCredentialsPath: string;
  };
  googleAccounts: {
    gmails: GoogleAccountConfig[];
    calendars: GoogleAccountConfig[];
  };
}

export interface OAuthRequestState {
  status: "pending" | "completed" | "error";
  purpose: GoogleAuthPurpose;
  accountId?: string;
  userId?: string;
  message?: string;
  updatedAt: number;
}

export interface GoogleAccountStatus {
  id: string;
  email: string;
  connected: boolean;
}

export interface GmailSubmissionRecord {
  id: string;
  accountId: string;
  accountEmail: string;
  subject: string;
  submittedAt: string;
  formKey: "work_report" | "schedule_change" | "handoff";
  formLabel: string;
  studentName?: string;
  sessionDate?: string;
  coachName?: string;
  coachCode?: string;
  submitterEmail?: string;
  studentCode?: string;
  scheduleChange?: {
    originalDate?: string;
    originalTime?: string;
    targetDate?: string;
    targetTime?: string;
    reason?: string;
  };
  handoff?: {
    studentCode?: string;
    policy?: "advance_premium" | "coach_change" | "substitute";
  };
  workReport?: {
    taskCategory?: string;
    taskLabel?: string;
    detailedTask?: string;
    intent?: "main" | "extra_thirty" | "handoff" | "administrative" | "other";
    studentCode?: string;
    participationStatus?: string;
    inferredHandoffStudentNames?: string[];
    inferredStudentNames?: string[];
  };
}

export type ReconciliationKind =
  | "main"
  | "schedule_change"
  | "handoff"
  | "handoff_five"
  | "extra_thirty"
  | "administrative"
  | "training"
  | "unknown";

export type ReconciliationStatus =
  | "submitted"
  | "submitted_confirmed"
  | "draft"
  | "review"
  | "stale"
  | "upcoming"
  | "autofill_ready"
  | "autofill_blocked"
  | "awaiting_user_submit"
  | "ignored";

export interface RuleEvidence {
  code: string;
  source: "rule" | "calendar" | "gmail" | "override" | "autofill";
  detail: string;
}

export interface SourceSnapshot {
  id: string;
  title: string;
  start?: string;
  end?: string;
  source: "calendar" | "gmail";
}

export interface TaskFieldSpec {
  title: string;
  kind: "text" | "textarea" | "radio" | "checkbox" | "dropdown" | "date" | "time" | "dateTime" | "duration";
  required: boolean;
  helpText?: string;
  options?: string[];
}

export type AnswerValue =
  | string
  | string[]
  | {
      date?: string;
      time?: string;
    };

export interface TaskPayload {
  answers: Record<string, AnswerValue>;
  fieldSpecs: TaskFieldSpec[];
  reviewHints: string[];
}

export interface AutofillTaskRecord {
  id: string;
  reconciliationId: string;
  plannedKind?: ReconciliationKind;
  formKey: "work_report" | "schedule_change" | "handoff";
  formType: "work_report_coaching" | "work_report_non_coaching" | "schedule_change" | "handoff";
  launchUrl: string;
  status: "autofill_ready" | "autofill_running" | "awaiting_user_submit" | "autofill_blocked" | "submitted_confirmed" | "error";
  payload: TaskPayload;
  missingFields: string[];
  createdAt: string;
  updatedAt: string;
  lastError?: string | null;
}

export interface StudentCodeDirectoryEntry {
  studentKey: string;
  studentName: string;
  studentCode: string;
  source: "manual" | "inferred";
  confidence: number;
  evidenceCount: number;
  updatedAt: string;
}

export interface StudentRoutineProfile {
  studentKey: string;
  studentName: string;
  course?: "standard" | "advance" | "premium" | "chat_support" | "unknown";
  teachingType?: "coaching_only" | "essay_teaching" | "past_exam_teaching" | "subject_teaching" | "unknown";
  weekday?: number | null;
  time?: string;
  durationMinutes?: number | null;
  expectedKinds: {
    main: boolean;
    extra_thirty: boolean;
    handoff: boolean;
    handoff_five: boolean;
  };
  note?: string;
  source: "manual" | "inferred";
  confidence: number;
  evidenceCount: number;
  updatedAt: string;
}

export interface ReconciliationOverrideRecord {
  studentName?: string;
  kind?: ReconciliationKind;
  ignored?: boolean;
  note?: string;
  updatedAt: string;
}

export interface CalendarActionSuggestion {
  id: string;
  type: "create" | "move";
  label: string;
  reason: string;
  selectionId?: string;
  title: string;
  start: string;
  end?: string;
  sourceEvent?: {
    id: string;
    accountId: string;
    googleCalendarId: string;
    googleEventId: string;
    title: string;
  };
}

export interface WorkflowAutofillSuggestion {
  id: string;
  kind: "schedule_change" | "handoff" | "handoff_five" | "extra_thirty";
  label: string;
  reason: string;
  confidence: number;
  preview?: string;
  originalDate?: string;
  originalTime?: string;
  targetDate?: string;
  targetTime?: string;
  durationMinutes?: number;
  handoffPolicy?: "advance_premium" | "coach_change" | "substitute";
}

export interface AutofillBundleItem {
  id: string;
  kind: ReconciliationKind;
  label: string;
  reason: string;
  eligibility: "ready" | "blocked" | "not_applicable";
  previewLines: string[];
  autofillReason: string;
  task?: AutofillTaskRecord | null;
}

export interface ApplicationFormItem {
  id: string;
  kind: ReconciliationKind;
  label: string;
  status: AutofillTaskRecord["status"] | "submitted" | "not_applicable";
  previewLines: string[];
  autofillReason: string;
  submittedAt?: string;
}

export interface RuntimeStateStore {
  reconciliationOverrides: Record<string, ReconciliationOverrideRecord>;
  invalidatedSubmissionIds: string[];
  autofillTasks: Record<string, AutofillTaskRecord>;
  studentCodeDirectory: Record<string, StudentCodeDirectoryEntry>;
  studentRoutineProfiles: Record<string, StudentRoutineProfile>;
}

export interface ReconciliationRecord {
  id: string;
  title: string;
  studentName: string;
  studentKey: string;
  start: string;
  end?: string;
  url?: string;
  status: ReconciliationStatus;
  kind: ReconciliationKind;
  source: "calendar" | "gmail";
  completionState: "missing" | "partial" | "complete";
  formLabel: string;
  attentionReason: string;
  ignored: boolean;
  accountEmail: string;
  location: string;
  sessionIds: string[];
  submissionIds: string[];
  relatedSources: SourceSnapshot[];
  calendarEvent?: {
    id: string;
    accountId: string;
    googleCalendarId: string;
    googleEventId: string;
    title: string;
  };
  ruleEvidence: RuleEvidence[];
  autofillEligibility: "ready" | "blocked" | "not_applicable";
  autofillReason: string;
  autofillTask?: AutofillTaskRecord | null;
  resolvedStudentCode?: string;
  studentCodeCandidate?: {
    studentCode: string;
    confidence: number;
    evidenceCount: number;
    source: "directory" | "history";
  };
  studentRoutineProfile?: StudentRoutineProfile;
  calendarSuggestions?: CalendarActionSuggestion[];
  workflowSuggestions?: WorkflowAutofillSuggestion[];
  autofillBundle?: AutofillBundleItem[];
  applicationForms?: ApplicationFormItem[];
  submission?: GmailSubmissionRecord;
}
