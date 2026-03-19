const selectedCalendarStorageKey = "gc-greenfield:selected-calendars";
const overviewRangeStorageKey = "gc-greenfield:overview-range";
const calendarDetailWidthStorageKey = "gc-greenfield:calendar-detail-width";
const fiscalYearsStorageKey = "gc-greenfield:selected-fiscal-years";
const activeViewStorageKey = "gc-greenfield:active-view";
const applicationFilterStorageKey = "gc-greenfield:application-filter";
const studentsSnapshotStorageKey = "gc-greenfield:students-snapshot";
const applicationsSnapshotStorageKey = "gc-greenfield:applications-snapshot";
const realtimeRefreshIntervalMs = 15000;

const VIEW_META = {
  calendar: { eyebrow: "Calendar", title: "カレンダー" },
  students: { eyebrow: "Students", title: "生徒" },
  applications: { eyebrow: "Applications", title: "申請" },
};

const APPLICATION_FILTERS = [
  { id: "all", label: "すべて" },
  { id: "submitted", label: "送信済み" },
  { id: "review", label: "要確認" },
  { id: "stale", label: "滞留" },
  { id: "ignored", label: "無視" },
];

const state = {
  me: null,
  authLoaded: false,
  gmailAccounts: [],
  calendarAccounts: [],
  activeView: "calendar",
  applicationFilter: "all",
  calendarSettingsExpanded: false,
  fiscalYearSettingsExpanded: false,
  calendars: [],
  events: [],
  calendar: null,
  students: [],
  applications: [],
  overviewRange: null,
  studentsLoaded: false,
  applicationsLoaded: false,
  studentsError: "",
  applicationsError: "",
  studentsLoading: null,
  applicationsLoading: null,
  staleNotificationInFlight: null,
  staleNotificationRequestKey: "",
  staleNotificationBlockedKey: "",
  selectedStudentId: null,
  editingStudentNameId: null,
  editingRecordTitleId: null,
  expandedReconciliations: new Set(),
  selectedCalendarRecord: null,
  calendarDetailLoading: false,
  calendarDetailError: "",
  calendarDetailWidth: 0.4,
  selectedFiscalYears: [],
};

let configSaveTimer = null;
const calendarTitleSaveTimers = new Map();
const studentRoutineSaveTimers = new Map();
let toastTimer = null;
let calendarDividerCleanup = null;
let calendarLayoutFrame = null;
let calendarLayoutSettledTimer = null;
let calendarResizeObserver = null;
let realtimeRefreshTimer = null;
let realtimeRefreshInFlight = null;
let autofillFollowupRefreshTimer = null;
let autofillFollowupRefreshAttempts = 0;
const calendarEventCache = new Map();
const calendarEventRequests = new Map();
const calendarEventCacheTtlMs = 120000;

const NEW_STUDENT_ID = "__new_student__";

function forEachSessionCollection(visitor) {
  visitor(state.applications);
  for (const student of state.students) {
    visitor(student.sessions || []);
  }
}

function applyLocalReconciliationMutation(id, mutate) {
  forEachSessionCollection((collection) => {
    collection.forEach((item, index) => {
      if (item?.id === id) {
        const next = mutate(item);
        if (next && next !== item) {
          collection[index] = next;
        }
      }
    });
  });
  if (state.selectedCalendarRecord?.id === id) {
    const next = mutate(state.selectedCalendarRecord);
    if (next && next !== state.selectedCalendarRecord) {
      state.selectedCalendarRecord = next;
    }
  }
}

function isPendingAutofillTaskStatus(status) {
  return ["autofill_running", "awaiting_user_submit", "submitted_confirmed"].includes(status);
}

function normalizePendingAutofillStatus(status) {
  if (status === "autofill_running" || status === "submitted_confirmed") {
    return "awaiting_user_submit";
  }
  return status;
}

function autofillTaskButtonLabel(status) {
  if (isPendingAutofillTaskStatus(status)) {
    return "送信未確認";
  }
  return "送信準備";
}

function pendingAutofillStatuses(application) {
  const statuses = [];
  if (isPendingAutofillTaskStatus(application?.autofillTask?.status)) {
    statuses.push(application.autofillTask.status);
  }
  for (const item of application?.autofillBundle ?? []) {
    if (isPendingAutofillTaskStatus(item.task?.status)) {
      statuses.push(item.task.status);
    }
  }
  return statuses;
}

function hasPendingAutofillState(application) {
  return pendingAutofillStatuses(application).length > 0;
}

function restoreActiveView() {
  const raw = localStorage.getItem(activeViewStorageKey);
  if (raw && ["calendar", "students", "applications"].includes(raw)) {
    state.activeView = raw;
  }
}

function persistActiveView() {
  localStorage.setItem(activeViewStorageKey, state.activeView);
}

function restoreApplicationFilter() {
  const raw = localStorage.getItem(applicationFilterStorageKey);
  if (raw && APPLICATION_FILTERS.some((item) => item.id === raw)) {
    state.applicationFilter = raw;
  }
}

function persistApplicationFilter() {
  localStorage.setItem(applicationFilterStorageKey, state.applicationFilter);
}

function summarySnapshotKey(meta) {
  return JSON.stringify(meta);
}

function loadSummarySnapshot(storageKey, meta) {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.key !== summarySnapshotKey(meta) || !Array.isArray(parsed.items)) {
      return null;
    }
    return parsed.items;
  } catch {
    return null;
  }
}

function saveSummarySnapshot(storageKey, meta, items) {
  try {
    localStorage.setItem(storageKey, JSON.stringify({
      key: summarySnapshotKey(meta),
      items,
      savedAt: new Date().toISOString(),
    }));
  } catch {
    // Ignore localStorage failures and continue without offline snapshot support.
  }
}

function applyLocalAutofillTaskResult(id, kindOverride, task) {
  if (!task) {
    return;
  }
  applyLocalReconciliationMutation(id, (record) => {
    const nextBundle = (record.autofillBundle ?? []).map((item) => {
      if (kindOverride && item.kind !== kindOverride) {
        return item;
      }
      if (!kindOverride && item.kind !== (task.plannedKind ?? record.kind)) {
        return item;
      }
      return {
        ...item,
        task: {
          ...task,
          status: normalizePendingAutofillStatus(task.status),
        },
      };
    });
    const nextApplicationForms = (record.applicationForms ?? []).map((item) => {
      if (kindOverride && item.kind !== kindOverride) {
        return item;
      }
      if (!kindOverride && item.kind !== (task.plannedKind ?? record.kind)) {
        return item;
      }
      return {
        ...item,
        status: normalizePendingAutofillStatus(task.status),
      };
    });
    const pendingStatuses = nextBundle
      .map((item) => item.task?.status)
      .map((status) => normalizePendingAutofillStatus(status))
      .filter((status) => isPendingAutofillTaskStatus(status));
    const nextStatus = pendingStatuses.includes("awaiting_user_submit")
        ? "awaiting_user_submit"
        : record.status;
    return {
      ...record,
      autofillTask: !kindOverride || (task.plannedKind ?? record.kind) === record.kind
        ? { ...task, status: normalizePendingAutofillStatus(task.status) }
        : record.autofillTask,
      autofillBundle: nextBundle,
      applicationForms: nextApplicationForms,
      status: nextStatus,
    };
  });
}

function scheduleAutofillFollowupRefresh() {
  if (autofillFollowupRefreshTimer) {
    window.clearTimeout(autofillFollowupRefreshTimer);
    autofillFollowupRefreshTimer = null;
  }
  autofillFollowupRefreshAttempts = 0;
  const tick = async () => {
    if (!state.applications.length && !state.students.length) {
      return;
    }
    const hasPending = state.applications.some(hasPendingAutofillState)
      || state.students.some((student) => (student.sessions || []).some(hasPendingAutofillState));
    if (!hasPending || autofillFollowupRefreshAttempts >= 40) {
      autofillFollowupRefreshTimer = null;
      autofillFollowupRefreshAttempts = 0;
      return;
    }
    autofillFollowupRefreshAttempts += 1;
    await runRealtimeRefresh();
    autofillFollowupRefreshTimer = window.setTimeout(() => {
      void tick();
    }, 5000);
  };
  autofillFollowupRefreshTimer = window.setTimeout(() => {
    void tick();
  }, 3000);
}

function calendarPaletteForCompletionState(stateValue) {
  if (stateValue === "complete") {
    return {
      backgroundColor: "#d9f1df",
      borderColor: "#86c79b",
      textColor: "#111111",
    };
  }
  if (stateValue === "partial") {
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

function calendarPaletteForRecord(record) {
  if (record?.ignored) {
    return {
      backgroundColor: "#e6eaee",
      borderColor: "#b7c0c9",
      textColor: "#425266",
    };
  }
  return calendarPaletteForCompletionState(record?.completionState);
}

function applyCalendarEventVisualState(record) {
  const calendarEventId = record?.calendarEvent?.id;
  if (!calendarEventId || !state.calendar) {
    return;
  }
  const event = state.calendar.getEventById(calendarEventId);
  if (!event) {
    return;
  }
  const { backgroundColor, borderColor, textColor } = calendarPaletteForRecord(record);
  event.setExtendedProp("backgroundColor", backgroundColor);
  event.setExtendedProp("borderColor", borderColor);
  event.setExtendedProp("textColor", textColor);
  event.setProp("backgroundColor", backgroundColor);
  event.setProp("borderColor", borderColor);
  event.setProp("textColor", textColor);
}

function queueImmediateRealtimeRefresh() {
  void runRealtimeRefresh();
  if (state.calendar && state.activeView !== "calendar") {
    state.calendar.refetchEvents();
  }
}

function removeLocalCalendarRecordByEventId(eventId) {
  state.applications = state.applications.filter((item) => item.calendarEvent?.id !== eventId && !item.sessionIds?.includes(eventId));
  state.students = state.students.map((student) => ({
    ...student,
    sessions: (student.sessions || []).filter((item) => item.calendarEvent?.id !== eventId && !item.sessionIds?.includes(eventId)),
  })).filter((student) => student.sessions.length > 0);
  if (state.selectedCalendarRecord?.calendarEvent?.id === eventId || state.selectedCalendarRecord?.sessionIds?.includes(eventId)) {
    clearCalendarDetail();
  }
  syncSelectedStudent();
}

function findLoadedCalendarRecord(eventId) {
  return state.applications.find((item) => item.calendarEvent?.id === eventId || item.sessionIds?.includes(eventId))
    || state.students.flatMap((student) => student.sessions || []).find((item) => item.calendarEvent?.id === eventId || item.sessionIds?.includes(eventId))
    || null;
}

function syncSelectedCalendarRecord() {
  if (!state.selectedCalendarRecord) {
    return;
  }
  const eventId = state.selectedCalendarRecord.calendarEvent?.id;
  if (!eventId) {
    return;
  }
  const nextRecord = findLoadedCalendarRecord(eventId);
  if (!nextRecord) {
    clearCalendarDetail();
    return;
  }
  state.selectedCalendarRecord = nextRecord;
}

function $(selector) {
  return document.querySelector(selector);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function loadPersistedCalendarDetailWidth() {
  try {
    const raw = Number(localStorage.getItem(calendarDetailWidthStorageKey));
    if (Number.isFinite(raw)) {
      return clamp(raw, 0.28, 0.6);
    }
  } catch {
  }
  return 0.4;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function displayStudentName(value) {
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .replace(/^[\p{Z}\s\u200B-\u200D\uFEFF]+|[\p{Z}\s\u200B-\u200D\uFEFF]+$/gu, "")
    .replace(/【.*?】/g, " ")
    .replace(/[\p{Z}\s]+/gu, /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(String(value ?? "")) ? "" : " ")
    .trim();
  return normalized;
}

function studentKeyFromName(value) {
  return displayStudentName(value)
    .normalize("NFKC")
    .toLowerCase();
}

function isMostlyJapaneseText(value) {
  const text = String(value ?? "");
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text) && !/[A-Za-z]/.test(text);
}

function renderNameText(value, className = "name-track") {
  const text = displayStudentName(value);
  if (!text) {
    return "";
  }
  if (!isMostlyJapaneseText(text)) {
    return escapeHtml(text);
  }
  const chars = Array.from(text);
  return `<span class="${className}" aria-label="${escapeHtml(text)}">${chars.map((char) => `<span class="name-char">${escapeHtml(char)}</span>`).join("")}</span>`;
}

function pencilIconMarkup() {
  return `
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M14.6 3.6a1.5 1.5 0 0 1 2.1 2.1l-8.8 8.8-3.4.9.9-3.4 8.8-8.8Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"></path>
      <path d="m11.9 4.8 3.3 3.3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"></path>
    </svg>
  `;
}

function toggleChevronMarkup() {
  return `
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M6 8.5 10 12.5 14 8.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
    </svg>
  `;
}

function unresolvedApplications() {
  return state.applications.filter((application) =>
    !application.ignored
    && ["draft", "review", "stale", "autofill_ready", "autofill_blocked", "awaiting_user_submit"].includes(application.status),
  );
}

function unresolvedCalendarApplications() {
  const seen = new Set();
  return state.students.flatMap((student) => student.sessions || []).filter((application) => {
    if (!application || seen.has(application.id)) {
      return false;
    }
    seen.add(application.id);
    return !application.ignored
      && ["draft", "review", "stale", "autofill_ready", "autofill_blocked", "awaiting_user_submit"].includes(application.status);
  });
}

function weekdayLabel(weekday) {
  return ["日", "月", "火", "水", "木", "金", "土"][weekday] ?? "未設定";
}

function routineCourseLabel(course) {
  return {
    standard: "スタンダード",
    advance: "アドバンス",
    premium: "プレミアム",
    chat_support: "チャットサポート",
    unknown: "未設定",
  }[course] ?? "未設定";
}

function routineTeachingTypeLabel(teachingType) {
  return {
    coaching_only: "通常コーチング",
    essay_teaching: "小論文ティーチング",
    past_exam_teaching: "過去問ティーチング",
    subject_teaching: "科目ティーチング",
    unknown: "未設定",
  }[teachingType] ?? "未設定";
}

function deriveExpectedKindsFromProfile(profile) {
  const course = profile?.course || "unknown";
  const teachingType = profile?.teachingType || "unknown";
  return {
    main: profile?.expectedKinds?.main !== false,
    handoff: Boolean(profile?.expectedKinds?.handoff) || course === "advance" || course === "premium",
    handoff_five: Boolean(profile?.expectedKinds?.handoff_five) || course === "advance" || course === "premium",
    extra_thirty: Boolean(profile?.expectedKinds?.extra_thirty) || ((course === "advance" || course === "premium") && (teachingType === "essay_teaching" || teachingType === "past_exam_teaching")),
  };
}

function routineKindLabels(expectedKinds = {}) {
  const labels = [];
  if (expectedKinds.main) {
    labels.push("本体申請");
  }
  if (expectedKinds.handoff) {
    labels.push("引き継ぎ");
  }
  if (expectedKinds.handoff_five) {
    labels.push("引き継ぎ5分");
  }
  if (expectedKinds.extra_thirty) {
    labels.push("追加30分");
  }
  return labels;
}

function routineSummary(profile) {
  if (!profile) {
    return "過去の申請履歴から定例パターンを判定できていません。";
  }
  const when = profile.weekday !== null && profile.weekday !== undefined && profile.time
    ? `毎週${weekdayLabel(profile.weekday)} ${profile.time}`
    : "日時未設定";
  const parts = [routineCourseLabel(profile.course), routineTeachingTypeLabel(profile.teachingType), when].filter(Boolean);
  return parts.join(" / ");
}

function routineExpectedKinds(profile) {
  return deriveExpectedKindsFromProfile(profile);
}

function buildStudentRoutinePayload(studentId) {
  const student = state.students.find((entry) => entry.id === studentId);
  if (!student) {
    return null;
  }
  const studentName = document.querySelector(`[data-student-display-name="${CSS.escape(studentId)}"]`)?.value?.trim() || student.name;
  const weekdayValue = document.querySelector(`[data-student-routine-weekday="${CSS.escape(studentId)}"]`)?.value;
  const time = document.querySelector(`[data-student-routine-time="${CSS.escape(studentId)}"]`)?.value?.trim() || "";
  const course = document.querySelector(`[data-student-routine-course="${CSS.escape(studentId)}"]`)?.value || "unknown";
  const teachingType = document.querySelector(`[data-student-routine-teaching="${CSS.escape(studentId)}"]`)?.value || "unknown";
  const expectedKinds = deriveExpectedKindsFromProfile({
    course,
    teachingType,
    expectedKinds: student.routineProfile?.expectedKinds,
  });
  return {
    studentName,
    course,
    teachingType,
    weekday: weekdayValue === "" ? null : Number(weekdayValue),
    time: time || undefined,
    durationMinutes: student.routineProfile?.durationMinutes ?? null,
    expectedKinds,
    note: student.routineProfile?.note || undefined,
    evidenceCount: student.routineProfile?.evidenceCount ?? 0,
  };
}

function applyLocalStudentRoutineProfile(studentId, payload) {
  const student = state.students.find((entry) => entry.id === studentId);
  if (!student) {
    return;
  }
  const previousName = student.name;
  const displayName = displayStudentName(payload.studentName);
  student.name = displayName;
  const nextProfile = {
    studentKey: student.id,
    studentName: payload.studentName,
    course: payload.course,
    teachingType: payload.teachingType,
    weekday: payload.weekday,
    time: payload.time,
    durationMinutes: payload.durationMinutes,
    expectedKinds: payload.expectedKinds,
    note: payload.note,
    source: "manual",
    confidence: 1,
    evidenceCount: Math.max(1, payload.evidenceCount || 0),
    updatedAt: new Date().toISOString(),
  };
  student.routineProfile = nextProfile;
  student.sessions = (student.sessions || []).map((item) => ({
    ...item,
    studentName: displayName,
    studentRoutineProfile: nextProfile,
  }));
  state.applications = state.applications.map((item) =>
    item.studentKey === student.id || displayStudentName(item.studentName) === displayStudentName(previousName)
      ? { ...item, studentName: displayName, studentRoutineProfile: nextProfile }
      : item
  );
  if (state.selectedCalendarRecord && (state.selectedCalendarRecord.studentKey === student.id || displayStudentName(state.selectedCalendarRecord.studentName) === displayStudentName(previousName))) {
    state.selectedCalendarRecord = {
      ...state.selectedCalendarRecord,
      studentName: displayName,
      studentRoutineProfile: nextProfile,
    };
  }
}

function scheduleStudentRoutineSave(studentId) {
  if (studentRoutineSaveTimers.has(studentId)) {
    window.clearTimeout(studentRoutineSaveTimers.get(studentId));
  }
  studentRoutineSaveTimers.set(studentId, window.setTimeout(() => {
    studentRoutineSaveTimers.delete(studentId);
    void saveStudentRoutineProfile(studentId);
  }, 420));
}

async function saveStudentRoutineProfile(studentId) {
  const payload = buildStudentRoutinePayload(studentId);
  if (!payload) {
    return;
  }
  try {
    applyLocalStudentRoutineProfile(studentId, payload);
    renderStudents();
    await request(`/api/students/${encodeURIComponent(studentId)}/profile`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    markSummaryDirty();
    void refreshVisibleData();
  } catch (error) {
    noteError(error);
    markSummaryDirty();
    void refreshVisibleData();
  }
}

function syncCalendarSplitLayout() {
  const split = $("#calendar-split");
  const pane = $("#calendar-detail-pane");
  if (!split || !pane) {
    return;
  }
  split.style.setProperty("--calendar-detail-width", `${Math.round(state.calendarDetailWidth * 100)}%`);
  const open = Boolean(state.selectedCalendarRecord) && state.activeView === "calendar";
  split.classList.toggle("has-detail", open);
  pane.classList.toggle("open", open);
  pane.setAttribute("aria-hidden", open ? "false" : "true");
  split.classList.toggle("detail-open", open);
}

function bindCalendarDivider() {
  if (calendarDividerCleanup) {
    calendarDividerCleanup();
    calendarDividerCleanup = null;
  }
  const divider = $("#calendar-divider");
  const split = $("#calendar-split");
  if (!divider || !split) {
    return;
  }
  const onPointerDown = (event) => {
    if (!split.classList.contains("has-detail")) {
      return;
    }
    event.preventDefault();
    const rect = split.getBoundingClientRect();
    const onPointerMove = (moveEvent) => {
      const rightWidth = rect.right - moveEvent.clientX;
      const ratio = rightWidth / rect.width;
      state.calendarDetailWidth = clamp(ratio, 0.28, 0.6);
      localStorage.setItem(calendarDetailWidthStorageKey, String(state.calendarDetailWidth));
      syncCalendarSplitLayout();
      requestCalendarRelayout();
    };
    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
  };
  divider.addEventListener("pointerdown", onPointerDown);
  calendarDividerCleanup = () => divider.removeEventListener("pointerdown", onPointerDown);
}

function bindCalendarResizeObserver() {
  if (calendarResizeObserver) {
    calendarResizeObserver.disconnect();
    calendarResizeObserver = null;
  }
  if (typeof ResizeObserver === "undefined") {
    return;
  }
  const panel = $("#calendar-panel");
  const split = $("#calendar-split");
  const pane = $("#calendar-detail-pane");
  calendarResizeObserver = new ResizeObserver(() => {
    requestCalendarRelayout();
  });
  [panel, split, pane].filter(Boolean).forEach((element) => {
    calendarResizeObserver.observe(element);
  });
  split?.addEventListener("transitionend", () => requestCalendarRelayout(), { passive: true });
}

function requestCalendarRelayout(refetch = false) {
  if (calendarLayoutFrame) {
    cancelAnimationFrame(calendarLayoutFrame);
  }
  if (calendarLayoutSettledTimer) {
    clearTimeout(calendarLayoutSettledTimer);
  }
  calendarLayoutFrame = requestAnimationFrame(() => {
    calendarLayoutFrame = null;
    if (!state.calendar || state.activeView !== "calendar") {
      return;
    }
    const targetHeight = syncCalendarLayout();
    state.calendar.setOption("height", targetHeight);
    state.calendar.updateSize();
    if (refetch) {
      state.calendar.refetchEvents();
    }
  });
  calendarLayoutSettledTimer = window.setTimeout(() => {
    calendarLayoutSettledTimer = null;
    if (!state.calendar || state.activeView !== "calendar") {
      return;
    }
    const targetHeight = syncCalendarLayout();
    state.calendar.setOption("height", targetHeight);
    state.calendar.updateSize();
  }, 220);
}

function setSettingsOpen(open) {
  const layer = $("#settings-layer");
  const trigger = $("#open-settings");
  layer.classList.toggle("open", open);
  layer.setAttribute("aria-hidden", open ? "false" : "true");
  trigger.setAttribute("aria-expanded", open ? "true" : "false");
}

function setCalendarSettingsExpanded(expanded) {
  state.calendarSettingsExpanded = expanded;
  const block = $("#calendar-settings-block");
  const toggle = $("#toggle-calendar-settings");
  if (!block || !toggle) {
    return;
  }
  block.classList.toggle("expanded", expanded);
  toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
}

function setFiscalYearSettingsExpanded(expanded) {
  state.fiscalYearSettingsExpanded = expanded;
  const block = $("#fiscal-year-settings-block");
  const toggle = $("#toggle-fiscal-year-settings");
  if (!block || !toggle) {
    return;
  }
  block.classList.toggle("expanded", expanded);
  toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
}

function setUploadNote(message) {
  const note = $("#oauth-upload-note");
  if (note) {
    note.textContent = message;
  }
  showToast(message);
}

function showToast(message, tone = "warning") {
  const toast = $("#global-toast");
  if (!toast || !message) {
    return;
  }
  toast.textContent = message;
  toast.className = `toast show ${tone}`;
  if (toastTimer) {
    window.clearTimeout(toastTimer);
  }
  toastTimer = window.setTimeout(() => {
    toast.className = "toast";
  }, 3600);
}

function setBridgeStatus(available) {
  const chip = $("#bridge-status-chip");
  if (!chip) {
    return;
  }
  chip.className = `bridge-status-chip ${available ? "ok" : "warning"}`;
  chip.textContent = available ? "検出済み" : "未検出";
}

function noteError(error, fallback = "操作を完了できませんでした") {
  const message = error instanceof Error ? error.message : fallback;
  setUploadNote(message || fallback);
  console.error(error);
}

function resetAuthenticatedState() {
  state.me = null;
  state.calendars = [];
  state.events = [];
  state.students = [];
  state.applications = [];
  state.studentsLoaded = false;
  state.applicationsLoaded = false;
  state.studentsError = "";
  state.applicationsError = "";
  clearCalendarDetail();
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
    },
    ...options,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      resetAuthenticatedState();
      state.authLoaded = true;
      stopRealtimeRefresh();
      renderAllViews();
    }
    throw new Error(payload.error || "Request failed");
  }
  return payload;
}

function clearCalendarEventCache() {
  calendarEventCache.clear();
  calendarEventRequests.clear();
}

function calendarEventCacheKey(start, end) {
  return JSON.stringify({
    start,
    end,
    calendarIds: selectedCalendarIds().slice().sort(),
  });
}

function selectedCalendarIdsKey() {
  return JSON.stringify(selectedCalendarIds().slice().sort());
}

function getCachedCalendarEvents(start, end) {
  const requestedStart = new Date(start).getTime();
  const requestedEnd = new Date(end).getTime();
  const requestedCalendarIds = selectedCalendarIdsKey();
  for (const [key, cached] of calendarEventCache.entries()) {
    if (!cached || cached.expiresAt <= Date.now()) {
      calendarEventCache.delete(key);
      continue;
    }
    const cachedStart = new Date(cached.start).getTime();
    const cachedEnd = new Date(cached.end).getTime();
    if (
      cached.calendarIdsKey === requestedCalendarIds
      && Number.isFinite(cachedStart)
      && Number.isFinite(cachedEnd)
      && cachedStart <= requestedStart
      && cachedEnd >= requestedEnd
    ) {
      return cached.events;
    }
  }
  return null;
}

function visibleCalendarEvents(events) {
  return (events || []).filter((event) => isInSelectedFiscalYears(event.start));
}

async function fetchCalendarEvents(start, end) {
  const key = calendarEventCacheKey(start, end);
  const cached = getCachedCalendarEvents(start, end);
  if (cached) {
    return cached;
  }
  if (calendarEventRequests.has(key)) {
    return calendarEventRequests.get(key);
  }
  const requestPromise = request(
    `/api/google/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&calendarIds=${encodeURIComponent(selectedCalendarIds().join(","))}`,
  )
    .then((payload) => {
      const events = payload.events || [];
      calendarEventCache.set(key, {
        start,
        end,
        calendarIdsKey: selectedCalendarIdsKey(),
        expiresAt: Date.now() + calendarEventCacheTtlMs,
        events,
      });
      return events;
    })
    .finally(() => {
      calendarEventRequests.delete(key);
    });
  calendarEventRequests.set(key, requestPromise);
  return requestPromise;
}

function prefetchCalendarEvents(start, end) {
  if (!state.calendars.length || selectedCalendarIds().length === 0) {
    return;
  }
  void fetchCalendarEvents(start, end).catch(() => {});
}

function shiftCalendarRangeByMonths(start, end, months) {
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime())) {
    return null;
  }
  startDate.setUTCMonth(startDate.getUTCMonth() + months);
  endDate.setUTCMonth(endDate.getUTCMonth() + months);
  return {
    start: startDate.toISOString(),
    end: endDate.toISOString(),
  };
}

function expandedCalendarRange(start, end, monthRadius = 1) {
  const backward = shiftCalendarRangeByMonths(start, end, -monthRadius);
  const forward = shiftCalendarRangeByMonths(start, end, monthRadius);
  if (!backward || !forward) {
    return { start, end };
  }
  return {
    start: backward.start,
    end: forward.end,
  };
}

function filterCalendarEventsForRange(events, start, end) {
  const rangeStart = new Date(start).getTime();
  const rangeEnd = new Date(end).getTime();
  return (events || []).filter((event) => {
    const eventStart = new Date(event.start).getTime();
    const eventEnd = new Date(event.end || event.start).getTime();
    return Number.isFinite(eventStart)
      && Number.isFinite(eventEnd)
      && eventStart < rangeEnd
      && eventEnd >= rangeStart;
  });
}

function prefetchCalendarWindow(start, end, monthRadius = 1) {
  const expanded = expandedCalendarRange(start, end, monthRadius);
  prefetchCalendarEvents(expanded.start, expanded.end);
}

function calendarChoiceBySelectionId(selectionId) {
  return state.calendars.find((calendar) => calendar.id === selectionId) || null;
}

function buildLocalCalendarEvent(selectionId, eventLike) {
  const choice = calendarChoiceBySelectionId(selectionId);
  const [accountId, ...calendarRest] = String(selectionId || "").split("::");
  const googleCalendarId = calendarRest.join("::");
  return {
    id: eventLike.id,
    title: eventLike.title,
    start: eventLike.start,
    end: eventLike.end,
    url: eventLike.url,
    backgroundColor: eventLike.backgroundColor || choice?.backgroundColor,
    borderColor: eventLike.borderColor || choice?.backgroundColor,
    extendedProps: {
      calendarId: selectionId,
      accountId,
      accountEmail: choice?.accountEmail || accountId,
      googleCalendarId,
      googleEventId: eventLike.googleEventId || "",
      description: eventLike.description,
      location: eventLike.location,
    },
  };
}

function insertLocalCalendarEvent(eventLike, { replaceId } = {}) {
  if (!state.calendar) {
    return;
  }
  if (replaceId) {
    state.calendar.getEventById(replaceId)?.remove();
  }
  state.calendar.getEventById(eventLike.id)?.remove();
  state.calendar.addEvent(eventLike);
}

function markSummaryDirty(options = {}) {
  const {
    students = true,
    applications = true,
  } = options;
  clearCalendarEventCache();
  if (students) {
    state.studentsLoaded = false;
  }
  if (applications) {
    state.applicationsLoaded = false;
  }
}

async function refreshVisibleData(options = {}) {
  const {
    students = true,
    applications = true,
    refetchCalendar = false,
  } = options;
  const tasks = [];
  if (students && state.activeView === "students") {
    tasks.push(ensureStudentsData(true));
  }
  if (applications && state.activeView === "applications") {
    tasks.push(ensureApplicationsData(true));
  }
  if (refetchCalendar && state.activeView === "calendar") {
    const calendar = ensureCalendar();
    syncCalendarLayout();
    calendar.refetchEvents();
  }
  if (tasks.length > 0) {
    await Promise.all(tasks);
  } else {
    renderAllViews();
  }
}

function preloadSidebarData(force = false) {
  if (!state.calendars.length || selectedCalendarIds().length === 0) {
    return;
  }
  if (state.activeView === "students") {
    void ensureStudentsData(force);
    return;
  }
  if (state.activeView === "applications") {
    void ensureApplicationsData(force);
  }
}

function selectedCalendarIds() {
  return Array.from(document.querySelectorAll("#settings-calendar-picker input:checked")).map((input) => input.value);
}

function persistSelectedCalendarIds(calendarIds) {
  localStorage.setItem(selectedCalendarStorageKey, JSON.stringify(calendarIds));
}

function loadPersistedSelection() {
  try {
    const raw = localStorage.getItem(selectedCalendarStorageKey);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function defaultSelectedCalendars(calendars, persistedIds) {
  const validPersisted = calendars
    .filter((calendar) => persistedIds.has(calendar.id))
    .map((calendar) => calendar.id);
  const baito = calendars.find((calendar) => calendar.summary === "バイト");

  if (validPersisted.length > 0 && (!baito || validPersisted.includes(baito.id))) {
    return new Set(validPersisted);
  }

  if (baito) {
    return new Set([baito.id]);
  }

  const primary = calendars.find((calendar) => calendar.primary);
  if (primary) {
    return new Set([primary.id]);
  }

  return new Set();
}

function defaultOverviewRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 6, 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 6, 0);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

function currentFiscalYear(date = new Date()) {
  return date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
}

function defaultFiscalYears() {
  return [currentFiscalYear()];
}

function availableFiscalYears() {
  const base = currentFiscalYear();
  return Array.from({ length: 6 }, (_, index) => base - 3 + index).reverse();
}

function loadPersistedFiscalYears() {
  try {
    const raw = localStorage.getItem(fiscalYearsStorageKey);
    if (!raw) {
      return defaultFiscalYears();
    }
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const years = parsed
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value))
        .sort((left, right) => right - left);
      if (years.length > 0) {
        return years;
      }
    }
  } catch {
  }
  return defaultFiscalYears();
}

function persistFiscalYears(years) {
  localStorage.setItem(fiscalYearsStorageKey, JSON.stringify(years));
}

function selectedFiscalYears() {
  return state.selectedFiscalYears.length > 0 ? state.selectedFiscalYears : defaultFiscalYears();
}

function fiscalYearBounds(year) {
  const start = new Date(Date.UTC(year, 3, 1, 0, 0, 0));
  const end = new Date(Date.UTC(year + 1, 2, 31, 14, 59, 59));
  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

function fiscalYearForDate(value) {
  const date = new Date(value);
  return date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
}

function isInSelectedFiscalYears(value) {
  if (!value) {
    return false;
  }
  return selectedFiscalYears().includes(fiscalYearForDate(value));
}

function selectedFiscalYearRange() {
  const years = selectedFiscalYears().slice().sort((left, right) => left - right);
  const first = fiscalYearBounds(years[0]);
  const last = fiscalYearBounds(years[years.length - 1]);
  return {
    start: first.start,
    end: last.end,
  };
}

function loadPersistedOverviewRange() {
  try {
    const raw = localStorage.getItem(overviewRangeStorageKey);
    if (!raw) {
      return defaultOverviewRange();
    }
    const parsed = JSON.parse(raw);
    if (typeof parsed?.startDate === "string" && typeof parsed?.endDate === "string") {
      return parsed;
    }
  } catch {
  }
  return defaultOverviewRange();
}

function persistOverviewRange(range) {
  localStorage.setItem(overviewRangeStorageKey, JSON.stringify(range));
}

function currentOverviewRange() {
  return state.overviewRange ?? defaultOverviewRange();
}

function normalizedOverviewRange() {
  const range = currentOverviewRange();
  return range.startDate <= range.endDate
    ? range
    : { startDate: range.endDate, endDate: range.startDate };
}

function overviewRangeToIso(range = normalizedOverviewRange()) {
  return {
    start: new Date(`${range.startDate}T00:00:00+09:00`).toISOString(),
    end: new Date(`${range.endDate}T23:59:59+09:00`).toISOString(),
  };
}

function syncOverviewRangeInputs() {
  const range = currentOverviewRange();
  $("#applications-range-start").value = range.startDate;
  $("#applications-range-end").value = range.endDate;
}

function renderFiscalYearPicker() {
  const root = $("#settings-fiscal-year-picker");
  const summary = $("#fiscal-year-selection-summary");
  if (!root || !summary) {
    return;
  }
  const selected = new Set(selectedFiscalYears());
  root.innerHTML = availableFiscalYears().map((year) => `
    <label class="calendar-option">
      <input type="checkbox" value="${year}" ${selected.has(year) ? "checked" : ""} />
      <span>
        <span class="calendar-option-primary">${year}年度</span>
        <span class="calendar-option-secondary">${year}/04/01 - ${year + 1}/03/31</span>
      </span>
    </label>
  `).join("");
  summary.textContent = `${selected.size}件`;
}

function normalizeStudentName(title) {
  const raw = String(title ?? "").trim();
  if (!raw) {
    return "未特定";
  }

  let text = raw
    .replace(/（.*?）/g, " ")
    .replace(/\(.*?\)/g, " ")
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

function formatDateTime(isoString) {
  if (!isoString) {
    return "日時未設定";
  }
  return new Intl.DateTimeFormat("ja-JP", {
    month: "short",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(isoString));
}

function formatDateOnly(isoString) {
  if (!isoString) {
    return "未設定";
  }
  const date = new Date(isoString);
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function applicationDisplayDate(application) {
  if (application.source === "gmail" && application.submission?.formKey === "work_report" && application.submission?.sessionDate) {
    return formatDateOnly(`${application.submission.sessionDate}T00:00:00+09:00`);
  }
  return formatDateTime(application.start);
}

const jstDayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function jstDayKey(value) {
  return jstDayFormatter.format(new Date(value));
}

function jstDayDiff(start) {
  const today = jstDayKey(Date.now());
  return Math.round((new Date(`${today}T00:00:00+09:00`).getTime() - new Date(`${jstDayKey(start)}T00:00:00+09:00`).getTime()) / 86_400_000);
}

function derivePendingApplicationStatus(start) {
  const dayDiff = jstDayDiff(start);
  if (dayDiff < 0) {
    return "upcoming";
  }
  if (dayDiff === 0) {
    return "draft";
  }
  return "stale";
}

function localAttentionReason(status, start) {
  const elapsedDays = Math.max(0, jstDayDiff(start));
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

function deriveRestoredReconciliationStatus(record) {
  if (
    record.lastActiveStatus
    && record.lastActiveStatus !== "ignored"
    && record.lastActiveStatus !== "autofill_ready"
    && record.lastActiveStatus !== "autofill_blocked"
  ) {
    return record.lastActiveStatus;
  }
  if (
    record.status
    && record.status !== "ignored"
    && record.status !== "autofill_ready"
    && record.status !== "autofill_blocked"
  ) {
    return record.status;
  }
  if (record.autofillTask?.status === "awaiting_user_submit") {
    return "awaiting_user_submit";
  }
  if (record.source === "calendar") {
    const pendingStatus = derivePendingApplicationStatus(record.start);
    if ((record.submissionIds ?? []).length > 0) {
      return "submitted";
    }
    if (record.completionState === "partial") {
      return pendingStatus === "stale" ? "stale" : "review";
    }
    return pendingStatus;
  }
  return record.status === "ignored" ? "review" : record.status;
}

function applyLocalSubmissionInvalidation(submissionId) {
  state.applications = state.applications.flatMap((record) => {
    if (!(record.submissionIds || []).includes(submissionId)) {
      return [record];
    }
    if (record.source === "gmail") {
      return [];
    }
    const pendingStatus = derivePendingApplicationStatus(record.start);
    const nextStatus = record.completionState === "partial"
      ? (pendingStatus === "stale" ? "stale" : "review")
      : pendingStatus;
    return [{
      ...record,
      submissionIds: (record.submissionIds || []).filter((id) => id !== submissionId),
      submission: record.submission?.id === submissionId ? undefined : record.submission,
      formLabel: record.submission?.id === submissionId ? "" : record.formLabel,
      status: nextStatus,
      attentionReason: record.completionState === "partial"
        ? record.attentionReason
        : localAttentionReason(nextStatus, record.start),
    }];
  });
  state.students = state.students
    .map((student) => ({
      ...student,
      sessions: (student.sessions || []).flatMap((record) => {
        if (!(record.submissionIds || []).includes(submissionId)) {
          return [record];
        }
        if (record.source === "gmail") {
          return [];
        }
        const pendingStatus = derivePendingApplicationStatus(record.start);
        const nextStatus = record.completionState === "partial"
          ? (pendingStatus === "stale" ? "stale" : "review")
          : pendingStatus;
        return [{
          ...record,
          submissionIds: (record.submissionIds || []).filter((id) => id !== submissionId),
          submission: record.submission?.id === submissionId ? undefined : record.submission,
          formLabel: record.submission?.id === submissionId ? "" : record.formLabel,
          status: nextStatus,
          attentionReason: record.completionState === "partial"
            ? record.attentionReason
            : localAttentionReason(nextStatus, record.start),
        }];
      }),
    }))
    .filter((student) => (student.sessions || []).length > 0);
  if ((state.selectedCalendarRecord?.submissionIds || []).includes(submissionId)) {
    if (state.selectedCalendarRecord.source === "gmail") {
      clearCalendarDetail();
    } else {
      const pendingStatus = derivePendingApplicationStatus(state.selectedCalendarRecord.start);
      const nextStatus = state.selectedCalendarRecord.completionState === "partial"
        ? (pendingStatus === "stale" ? "stale" : "review")
        : pendingStatus;
      state.selectedCalendarRecord = {
        ...state.selectedCalendarRecord,
        submissionIds: (state.selectedCalendarRecord.submissionIds || []).filter((id) => id !== submissionId),
        submission: state.selectedCalendarRecord.submission?.id === submissionId ? undefined : state.selectedCalendarRecord.submission,
        formLabel: state.selectedCalendarRecord.submission?.id === submissionId ? "" : state.selectedCalendarRecord.formLabel,
        status: nextStatus,
        attentionReason: state.selectedCalendarRecord.completionState === "partial"
          ? state.selectedCalendarRecord.attentionReason
          : localAttentionReason(nextStatus, state.selectedCalendarRecord.start),
      };
    }
  }
}

function applyLocalCalendarSuggestionResolution(recordId) {
  state.applications = state.applications.flatMap((record) => {
    if (record.id !== recordId) {
      return [record];
    }
    if (record.source === "gmail") {
      return [];
    }
    return [{
      ...record,
      calendarSuggestions: [],
    }];
  });
  state.students = state.students
    .map((student) => ({
      ...student,
      sessions: (student.sessions || []).flatMap((record) => {
        if (record.id !== recordId) {
          return [record];
        }
        if (record.source === "gmail") {
          return [];
        }
        return [{
          ...record,
          calendarSuggestions: [],
        }];
      }),
    }))
    .filter((student) => (student.sessions || []).length > 0);
  if (state.selectedCalendarRecord?.id === recordId) {
    if (state.selectedCalendarRecord.source === "gmail") {
      clearCalendarDetail();
    } else {
      state.selectedCalendarRecord = {
        ...state.selectedCalendarRecord,
        calendarSuggestions: [],
      };
    }
  }
  syncSelectedStudent();
}

function applicationStatusLabel(status) {
  return {
    submitted: "送信済み",
    submitted_confirmed: "送信未確認",
    draft: "要確認",
    review: "要確認",
    stale: "滞留",
    upcoming: "実施待機",
    autofill_ready: "自動入力可",
    autofill_blocked: "自動入力停止",
    awaiting_user_submit: "送信未確認",
    ignored: "無視",
  }[status] ?? status;
}

function reconciliationKindLabel(kind) {
  return {
    main: "本体申請",
    schedule_change: "日程変更",
    handoff: "引き継ぎ",
    extra_thirty: "追加30分",
    administrative: "事務",
    training: "研修",
    unknown: "未確定",
  }[kind] ?? kind;
}

function applicationIssueKind(application) {
  if (application.source !== "gmail") {
    return "";
  }
  if (application.submission?.formKey === "schedule_change") {
    return "schedule_change";
  }
  const intent = application.submission?.workReport?.intent;
  if (intent === "extra_thirty") {
    return "extra_thirty";
  }
  if (intent === "handoff") {
    return "handoff";
  }
  return "unmatched";
}

function applicationIssueLabel(application) {
  return {
    schedule_change: "日程変更",
    extra_thirty: "追加30分",
    handoff: "引き継ぎ",
    unmatched: "未紐付け",
  }[applicationIssueKind(application)] ?? "";
}

function applicationIssuePriority(application) {
  return {
    schedule_change: 0,
    extra_thirty: 1,
    handoff: 2,
    unmatched: 3,
    "": 9,
  }[applicationIssueKind(application)] ?? 9;
}

function applicationMetaChips(application) {
  const chips = [];
  const issueLabel = applicationIssueLabel(application);
  if (issueLabel) {
    chips.push(`<span class="source-chip issue-chip issue-${applicationIssueKind(application)}">${escapeHtml(issueLabel)}</span>`);
  }
  if (application.source === "gmail" && application.formLabel) {
    chips.push(`<span class="source-chip ${application.source}">${escapeHtml(application.formLabel)}</span>`);
  }
  return chips.join("");
}

function applicationResultTitle(application) {
  if (application.source === "calendar") {
    return application.title;
  }

  const studentName = application.studentName || "未特定";
  const issueKind = applicationIssueKind(application);
  if (issueKind === "schedule_change") {
    return `${studentName} の日程変更`;
  }
  if (issueKind === "extra_thirty") {
    return `${studentName} の追加30分`;
  }
  if (issueKind === "handoff") {
    return `${studentName} の引き継ぎ`;
  }
  return `${studentName} の未紐付け申請`;
}

function applicationResultSummary(application) {
  if (application.source === "calendar") {
    return "";
  }
  return application.title;
}

function compareDisplayText(left, right) {
  const normalize = (value) => displayStudentName(value)
    .replace(/\s+/g, "")
    .replace(/さん$/u, "")
    .trim();
  return normalize(left) === normalize(right);
}

function isExpandedReconciliation(id) {
  return state.expandedReconciliations.has(id);
}

function toggleReconciliation(id) {
  if (state.expandedReconciliations.has(id)) {
    state.expandedReconciliations.delete(id);
  } else {
    state.expandedReconciliations.add(id);
  }
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll('"', "&quot;");
}

function calendarSuggestionSummary(suggestion) {
  return `${applicationDisplayDate({ start: suggestion.start, source: "calendar" })}${suggestion.reason ? ` / ${suggestion.reason}` : ""}`;
}

function calendarSuggestionButtonLabel(suggestion) {
  if (suggestion.type === "create") {
    return "作成";
  }
  if (suggestion.label === "時間を変更") {
    return "変更";
  }
  return "移動";
}

function workflowSuggestionLabel(kind) {
  return {
    schedule_change: "日程変更",
    extra_thirty: "追加作業報告",
    handoff: "引き継ぎ",
    handoff_five: "引き継ぎ5分",
  }[kind] ?? "追加候補";
}

function autofillBundleItems(application) {
  return application.autofillBundle ?? [];
}

function applicationFormItems(application) {
  return application.applicationForms ?? autofillBundleItems(application);
}

function applicationRunnableFormItems(application) {
  return applicationFormItems(application).filter((item) =>
    item.kind !== "schedule_change"
    && item.status !== "submitted"
    && item.status !== "autofill_blocked"
    && item.status !== "not_applicable",
  );
}

function autofillReadyBundleItems(application) {
  return autofillBundleItems(application).filter((item) =>
    item.eligibility === "ready" && !isPendingAutofillTaskStatus(item.task?.status),
  );
}

function autofillPendingBundleItems(application) {
  return autofillBundleItems(application).filter((item) => isPendingAutofillTaskStatus(item.task?.status));
}

function autofillRunnableBundleItems(application) {
  return autofillBundleItems(application).filter((item) =>
    item.eligibility === "ready" || isPendingAutofillTaskStatus(item.task?.status),
  );
}

function autofillBlockedBundleReason(application) {
  const reasons = autofillBundleItems(application)
    .filter((item) => item.eligibility !== "ready" && !isPendingAutofillTaskStatus(item.task?.status))
    .map((item) => `${item.label}: ${item.autofillReason}`)
    .filter((reason) => !reason.endsWith(": 自動入力できます。") && !reason.endsWith(": 準備可"))
    .filter(Boolean);
  return reasons.join(" / ");
}

function autofillButtonMarkup(application) {
  if (application.status === "upcoming") {
    return "";
  }
  const bundle = autofillBundleItems(application);
  const readyItems = autofillReadyBundleItems(application);
  const pendingItems = autofillPendingBundleItems(application);
  if (bundle.length > 0) {
    if (readyItems.length > 0 || pendingItems.length > 0) {
      return `<button class="primary" data-run-autofill-bundle="${escapeAttr(application.id)}">送信準備</button>`;
    }
    const reason = autofillBlockedBundleReason(application) || "自動入力の前に補足情報が必要です。";
    return `<button class="secondary" type="button" data-show-autofill-reason="${escapeAttr(application.id)}" title="${escapeAttr(reason)}">送信準備</button>`;
  }
  if (!application.autofillTask && application.autofillEligibility === "not_applicable") {
    return "";
  }
  if (isPendingAutofillTaskStatus(application.autofillTask?.status)) {
    return `<button class="primary" data-run-autofill="${escapeAttr(application.id)}">送信準備</button>`;
  }
  if (application.autofillEligibility === "ready" && application.autofillTask) {
    return `<button class="primary" data-run-autofill="${escapeAttr(application.id)}">送信準備</button>`;
  }
  const reason = application.autofillReason && application.autofillReason !== "滞留のみ対象です。"
    ? application.autofillReason
    : "自動入力の前に補足情報が必要です。";
  return `<button class="secondary" type="button" data-show-autofill-reason="${escapeAttr(application.id)}" title="${escapeAttr(reason)}">送信準備</button>`;
}

function splitAutofillReasons(reason) {
  return String(reason || "")
    .split("/")
    .map((item) => item.trim())
    .filter(Boolean);
}

function shortAutofillReasonLabel(reason) {
  const reasons = splitAutofillReasons(reason);
  if (reasons.length === 0) {
    return "要補足";
  }
  const first = reasons[0];
  if (first === "自動入力できます。" || first === "準備可") {
    return "準備可";
  }
  if (first.includes("生徒コード")) {
    return "生徒コード";
  }
  if (first.includes("参加状況")) {
    return "参加状況";
  }
  if (first.includes("コーチ情報") || first.includes("コーチ")) {
    return "コーチ情報";
  }
  if (first.includes("引き継ぎ種別")) {
    return "引き継ぎ種別";
  }
  if (first.includes("業務依頼者")) {
    return "業務依頼者";
  }
  if (first.includes("送信状況")) {
    return "要確認";
  }
  if (first.includes("回答メール")) {
    return "送信未確認";
  }
  return first.replace(/です。?$/u, "").replace(/の確認が必要です。?$/u, "");
}

function autofillReasonDetail(reason) {
  const reasons = splitAutofillReasons(reason);
  if (reasons.length === 0) {
    return "";
  }
  if (
    reasons.length === 1
    && (reasons[0] === "自動入力できます。" || reasons[0] === "準備可")
  ) {
    return "";
  }
  return reasons.join(" / ");
}

function isMailConfirmationPendingItem(item) {
  if (!item) {
    return false;
  }
  if (item.status === "awaiting_user_submit" || item.status === "submitted_confirmed") {
    return true;
  }
  const detail = autofillReasonDetail(item.autofillReason);
  return detail.includes("回答メール");
}

function applicationFormMetaText(item) {
  if (item.status === "submitted") {
    return item.submittedAt ? `回答メール確認済み: ${formatDateTime(item.submittedAt)}` : "回答メールを確認しました。";
  }
  if (isMailConfirmationPendingItem(item)) {
    return "回答メールはまだ確認できていません。送信できたか確認してください。";
  }
  if (item.status === "autofill_ready") {
    return "";
  }
  const detail = autofillReasonDetail(item.autofillReason);
  if (!detail || detail === "自動入力できます。" || detail === "準備可") {
    return "";
  }
  if (detail.includes("回答メール")) {
    return detail;
  }
  return `不足: ${detail}`;
}

function applicationFormStatusMarkup(application, item) {
  if (application.status === "upcoming") {
    return `<span class="status-chip draft">実施待機</span>`;
  }
  if (item.status === "submitted") {
    return `<span class="status-chip submitted">送信済み</span>`;
  }
  if (isMailConfirmationPendingItem(item)) {
    return `<span class="status-chip awaiting_user_submit">送信未確認</span>`;
  }
  return `<span class="status-chip ${item.status === "autofill_ready" ? "submitted" : "review"}">${item.status === "autofill_ready" ? "準備可" : escapeHtml(shortAutofillReasonLabel(item.autofillReason))}</span>`;
}

function shouldShowAutofillReason(application) {
  if (!application.autofillReason || application.autofillReason === "滞留のみ対象です。") {
    return false;
  }
  if (application.autofillEligibility === "ready") {
    return false;
  }
  const detail = autofillReasonDetail(application.autofillReason);
  return Boolean(detail);
}

function detailIssueLabel(application) {
  return applicationIssueLabel(application) || reconciliationKindLabel(application.kind);
}

function detailSourceSummary(application) {
  return application.calendarEvent ? "" : "対応する予定がありません。";
}

function isScheduleChangeSourceSnapshot(item) {
  return item.source === "gmail" && item.title.includes("->");
}

function formatSourceSnapshot(item) {
  const prefix = item.source === "calendar" ? "予定" : "申請履歴";
  if (item.source === "calendar") {
    return `${prefix} / ${item.title}${item.start ? ` , ${formatDateTime(item.start)}` : ""}`;
  }
  if (isScheduleChangeSourceSnapshot(item)) {
    return `${prefix} / ${item.title}${item.start ? ` + ${formatDateTime(item.start)}` : ""}`;
  }
  if (item.start) {
    return `${prefix} / ${item.title} / ${formatDateOnly(item.start)}`;
  }
  return `${prefix} / ${item.title}`;
}

function visibleRuleEvidence(application) {
  return (application.ruleEvidence ?? []).filter((item) => {
    const detail = String(item.detail || "");
    if (!detail) {
      return false;
    }
    if (detail === "本体申請を確認しました。") {
      return false;
    }
    if (/^次回は .* です。$/.test(detail)) {
      return false;
    }
    if (/^予定後 \d+ 日です。/.test(detail)) {
      return false;
    }
    return true;
  });
}

function calendarDetailMarkup(application) {
  const title = applicationDisplayDate(application);
  const subtitle = applicationResultTitle(application);
  const formSummary = applicationResultSummary(application);
  const sourceSummary = detailSourceSummary(application);
  const evidence = visibleRuleEvidence(application).slice(0, 4);
  const sources = (application.relatedSources ?? []).slice(0, 4);
  const renameValue = application.calendarEvent?.title ?? "";
  const editingTitle = state.editingRecordTitleId === application.id;
  const applicationForms = applicationFormItems(application);
  return `
    <article class="calendar-detail-card">
      <div class="calendar-detail-summary">
        <div class="calendar-detail-copy">
          <div class="calendar-detail-date">${escapeHtml(title)}</div>
          <div class="detail-title-row">
            ${editingTitle && application.calendarEvent
              ? `<input class="inline-input detail-title-input" data-calendar-title="${escapeAttr(application.id)}" type="text" value="${escapeAttr(renameValue)}" placeholder="予定名" />`
              : `<div class="calendar-detail-student">${renderNameText(subtitle)}</div>`}
            ${application.calendarEvent
              ? `<button class="icon-button subtle-icon-button" data-edit-calendar-title="${escapeAttr(application.id)}" type="button" aria-label="予定名を編集">${pencilIconMarkup()}</button>`
              : ""}
          </div>
          ${formSummary ? `<div class="calendar-detail-note">${escapeHtml(formSummary)}</div>` : ""}
        </div>
        <div class="calendar-detail-statuses">
          <span class="status-chip ${application.status}">${applicationStatusLabel(application.status)}</span>
        </div>
      </div>
      ${application.attentionReason ? `<p class="calendar-detail-reason">${escapeHtml(application.attentionReason)}</p>` : ""}
      <div class="calendar-detail-meta">
        ${sourceSummary ? `<span>${escapeHtml(sourceSummary)}</span>` : ""}
      </div>
      ${applicationForms.length > 0
        ? `
          <div class="detail-subsection">
            <p class="metric-label">申請フォーム</p>
            <div class="suggestion-list">
              ${applicationForms.map((item) => `
                <div class="suggestion-item autofill-bundle-item ${isMailConfirmationPendingItem(item) ? "mail-pending" : item.status === "autofill_blocked" ? "blocked" : "ready"}">
                  <div>
                    <div class="application-title">${escapeHtml(item.label)}</div>
                    <div class="application-meta">${escapeHtml(applicationFormMetaText(item))}</div>
                    ${(item.previewLines ?? []).length > 0
                      ? `<div class="detail-list compact">${item.previewLines.map((line) => `<div>${escapeHtml(line)}</div>`).join("")}</div>`
                      : ""}
                  </div>
                  ${applicationFormStatusMarkup(application, item)}
                </div>
              `).join("")}
            </div>
          </div>
        `
        : ""}
      ${(application.calendarSuggestions ?? []).length > 0
        ? `
          <div class="detail-subsection">
            <p class="metric-label">予定候補</p>
            <div class="suggestion-list">
              ${(application.calendarSuggestions ?? []).map((suggestion) => `
                <div class="suggestion-item">
                  <div>
                    <div class="application-title">${escapeHtml(suggestion.label)}</div>
                    <div class="application-meta">${escapeHtml(calendarSuggestionSummary(suggestion))}</div>
                  </div>
                  <button class="secondary" data-apply-calendar-suggestion="${escapeAttr(application.id)}" data-suggestion-id="${escapeAttr(suggestion.id)}">${escapeHtml(calendarSuggestionButtonLabel(suggestion))}</button>
                </div>
              `).join("")}
            </div>
          </div>
        `
        : ""}
      ${evidence.length > 0
        ? `
          <div class="detail-subsection">
            <p class="metric-label">判断根拠</p>
            <ul class="detail-list">${evidence.map((item) => `<li>${escapeHtml(item.detail)}</li>`).join("")}</ul>
          </div>
        `
        : ""}
      ${sources.length > 0
        ? `
          <div class="detail-subsection">
            <p class="metric-label">参照データ</p>
            <ul class="detail-list">${sources.map((item) => `<li>${escapeHtml(formatSourceSnapshot(item))}</li>`).join("")}</ul>
          </div>
        `
        : ""}
      <div class="detail-subsection calendar-detail-actions">
        <div class="detail-form detail-form-actions">
          ${application.calendarEvent ? `<button class="secondary" data-delete-calendar="${escapeAttr(application.id)}">削除</button>` : ""}
          ${application.ignored
            ? `<button class="secondary" data-restore-reconciliation="${escapeAttr(application.id)}">解除</button>`
            : `<button class="secondary" data-ignore-reconciliation="${escapeAttr(application.id)}">無視</button>`}
          ${application.submissionIds?.[0]
            ? `<button class="secondary" data-invalidate-submission="${escapeAttr(application.submissionIds[0])}">無効化</button>`
            : ""}
          ${autofillButtonMarkup(application)}
        </div>
      </div>
    </article>
  `;
}

let zenExtensionReadyPromise = null;

function hasZenBridgeMarker() {
  return document.documentElement.getAttribute("data-gc-zen-bridge") === "ready";
}

function waitForZenBridgeMarker(timeoutMs = 1200) {
  if (hasZenBridgeMarker()) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const done = (result) => {
      document.removeEventListener("gc-greenfield-zen-ready", onReady);
      window.clearTimeout(timer);
      resolve(result);
    };
    function onReady() {
      done(true);
    }
    const timer = window.setTimeout(() => done(hasZenBridgeMarker()), timeoutMs);
    document.addEventListener("gc-greenfield-zen-ready", onReady, { once: true });
    document.dispatchEvent(new CustomEvent("gc-greenfield-zen-ping"));
  });
}

function waitForExtensionMessage(expectedType, requestId, timeoutMs = 1200) {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("Zen extension response timeout"));
    }, timeoutMs);
    function onMessage(event) {
      if (event.source !== window) {
        return;
      }
      const message = event.data;
      if (!message || message.source !== "gc-greenfield-extension") {
        return;
      }
      if (message.type !== expectedType || message.requestId !== requestId) {
        return;
      }
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(message);
    }
    window.addEventListener("message", onMessage);
  });
}

async function hasZenAutofillExtension() {
  if (zenExtensionReadyPromise) {
    return zenExtensionReadyPromise;
  }
  if (hasZenBridgeMarker()) {
    setBridgeStatus(true);
    return true;
  }
  const requestId = crypto.randomUUID();
  zenExtensionReadyPromise = Promise.race([
    waitForZenBridgeMarker(500),
    waitForExtensionMessage("AUTOFILL_EXTENSION_READY", requestId, 500).then(() => true),
  ])
    .catch(() => false);
  document.dispatchEvent(new CustomEvent("gc-greenfield-zen-ping"));
  window.postMessage({
    source: "gc-greenfield-page",
    type: "AUTOFILL_EXTENSION_PING",
    requestId,
  }, "*");
  const result = await zenExtensionReadyPromise;
  setBridgeStatus(result);
  if (!result) {
    zenExtensionReadyPromise = null;
  }
  return result;
}

async function runZenAutofillTask(task) {
  const requestId = crypto.randomUUID();
  const waitForDomStarted = new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      document.removeEventListener("gc-greenfield-zen-started", onStarted);
      document.removeEventListener("gc-greenfield-zen-error", onError);
      reject(new Error("Zen bridge response timeout"));
    }, 2500);
    function cleanup() {
      window.clearTimeout(timer);
      document.removeEventListener("gc-greenfield-zen-started", onStarted);
      document.removeEventListener("gc-greenfield-zen-error", onError);
    }
    function onStarted(event) {
      if (event.detail?.requestId !== requestId) {
        return;
      }
      cleanup();
      resolve(event.detail);
    }
    function onError(event) {
      if (event.detail?.requestId !== requestId) {
        return;
      }
      cleanup();
      reject(new Error(event.detail?.error || "Zen extension error"));
    }
    document.addEventListener("gc-greenfield-zen-started", onStarted);
    document.addEventListener("gc-greenfield-zen-error", onError);
  });
  const waitForMessageStarted = waitForExtensionMessage("AUTOFILL_EXTENSION_STARTED", requestId, 2500);
  const waitForMessageError = waitForExtensionMessage("AUTOFILL_EXTENSION_ERROR", requestId, 2500).then((message) => {
    throw new Error(message.error || "Zen extension error");
  });
  document.dispatchEvent(new CustomEvent("gc-greenfield-zen-run", {
    detail: { requestId, task },
  }));
  window.postMessage({
    source: "gc-greenfield-page",
    type: "AUTOFILL_EXTENSION_RUN",
    requestId,
    task,
  }, "*");
  await Promise.race([waitForDomStarted, waitForMessageStarted, waitForMessageError]);
}

function reconciliationDetails(application) {
  const evidence = visibleRuleEvidence(application).map((item) => `<li>${escapeHtml(item.detail)}</li>`).join("");
  const sources = (application.relatedSources ?? []).map((item) => `<li>${escapeHtml(formatSourceSnapshot(item))}</li>`).join("");
  const renameValue = application.calendarEvent?.title ?? "";
  const editingTitle = state.editingRecordTitleId === application.id;
  const applicationForms = applicationFormItems(application);
  const showCalendarTitle = Boolean(application.calendarEvent);
  return `
    <div class="reconciliation-detail">
      ${showCalendarTitle
        ? `
          <div class="detail-title-row">
            ${editingTitle
              ? `<input class="inline-input detail-title-input" data-calendar-title="${escapeAttr(application.id)}" type="text" value="${escapeAttr(renameValue)}" placeholder="予定名" />`
              : `<div class="application-title">${escapeHtml(renameValue)}</div>`}
            <button class="icon-button subtle-icon-button" data-edit-calendar-title="${escapeAttr(application.id)}" type="button" aria-label="予定名を編集">${pencilIconMarkup()}</button>
          </div>
        `
        : ""}
      ${application.attentionReason ? `<p class="task-reason">${escapeHtml(application.attentionReason)}</p>` : ""}
      ${applicationForms.length > 0
        ? `
          <div class="detail-subsection">
            <p class="metric-label">申請フォーム</p>
            <div class="suggestion-list">
              ${applicationForms.map((item) => `
                <div class="suggestion-item autofill-bundle-item ${isMailConfirmationPendingItem(item) ? "mail-pending" : item.status === "autofill_blocked" ? "blocked" : "ready"}">
                  <div>
                    <div class="application-title">${escapeHtml(item.label)}</div>
                    <div class="application-meta">${escapeHtml(applicationFormMetaText(item))}</div>
                    ${(item.previewLines ?? []).length > 0
                      ? `<div class="detail-list compact">${item.previewLines.map((line) => `<div>${escapeHtml(line)}</div>`).join("")}</div>`
                      : ""}
                  </div>
                  ${applicationFormStatusMarkup(application, item)}
                </div>
              `).join("")}
            </div>
          </div>
        `
        : ""}
      ${evidence
        ? `
          <div class="detail-subsection">
            <p class="metric-label">根拠</p>
            <ul class="detail-list">${evidence}</ul>
          </div>
        `
        : ""}
      ${sources
        ? `
          <div class="detail-subsection">
            <p class="metric-label">関連データ</p>
            <ul class="detail-list">${sources}</ul>
          </div>
        `
        : ""}
      <div class="detail-subsection">
        <div class="detail-form detail-form-actions">
          ${application.calendarEvent ? `<button class="secondary" data-delete-calendar="${escapeAttr(application.id)}">削除</button>` : ""}
          ${application.ignored
            ? `<button class="secondary" data-restore-reconciliation="${escapeAttr(application.id)}">解除</button>`
            : `<button class="secondary" data-ignore-reconciliation="${escapeAttr(application.id)}">無視</button>`}
          ${application.submissionIds?.[0]
            ? `<button class="secondary" data-invalidate-submission="${escapeAttr(application.submissionIds[0])}">無効化</button>`
            : ""}
          ${autofillButtonMarkup(application)}
        </div>
        ${shouldShowAutofillReason(application) && applicationForms.length === 0
          ? `<p class="task-reason">${escapeHtml(autofillReasonDetail(application.autofillReason))}</p>`
          : ""}
      </div>
      ${application.studentCodeCandidate && !application.resolvedStudentCode
        ? `
          <div class="detail-subsection">
            <p class="metric-label">生徒コード候補</p>
            <div class="detail-form">
              <div class="application-meta">${escapeHtml(application.studentCodeCandidate.studentCode)} / 履歴${escapeHtml(application.studentCodeCandidate.evidenceCount)}件一致</div>
              <button class="secondary" data-save-student-code="${escapeAttr(application.id)}">台帳へ追加</button>
            </div>
          </div>
        `
        : ""}
      ${!application.resolvedStudentCode
        ? `
          <div class="detail-subsection">
            <p class="metric-label">生徒コード登録</p>
            <div class="detail-form">
              <input
                class="inline-input"
                data-manual-student-code="${escapeAttr(application.id)}"
                type="text"
                value="${escapeAttr(application.studentCodeCandidate?.studentCode ?? "")}"
                placeholder="生徒コード"
              />
              <button class="secondary" data-save-manual-student-code="${escapeAttr(application.id)}">台帳に登録</button>
            </div>
            <p class="task-reason">過去の申請履歴で割り出せない場合は、ここから生徒台帳へ登録します。</p>
          </div>
        `
        : ""}
      ${(application.calendarSuggestions ?? []).length > 0
        ? `
          <div class="detail-subsection">
            <p class="metric-label">予定候補</p>
            <div class="suggestion-list">
              ${(application.calendarSuggestions ?? []).map((suggestion) => `
                <div class="suggestion-item">
                  <div>
                    <div class="application-title">${escapeHtml(suggestion.label)}</div>
                    <div class="application-meta">${escapeHtml(calendarSuggestionSummary(suggestion))}</div>
                  </div>
                  <button class="secondary" data-apply-calendar-suggestion="${escapeAttr(application.id)}" data-suggestion-id="${escapeAttr(suggestion.id)}">${escapeHtml(calendarSuggestionButtonLabel(suggestion))}</button>
                </div>
              `).join("")}
            </div>
          </div>
        `
        : ""}
    </div>
  `;
}

function renderReconciliationRow(application, { datePrimary = true } = {}) {
  const primary = datePrimary ? escapeHtml(applicationDisplayDate(application)) : renderNameText(applicationResultTitle(application));
  const secondary = datePrimary ? renderNameText(applicationResultTitle(application)) : escapeHtml(applicationDisplayDate(application));
  const expanded = isExpandedReconciliation(application.id);
  return `
    <div class="application-row reconciliation-row ${expanded ? "expanded" : ""}">
      <div class="task-body">
        <div class="reconciliation-head">
          <div class="reconciliation-main">
            <button class="expand-button ${expanded ? "expanded" : ""}" data-toggle-reconciliation="${escapeAttr(application.id)}" type="button" aria-expanded="${expanded ? "true" : "false"}" aria-label="${expanded ? "閉じる" : "展開"}">${toggleChevronMarkup()}</button>
            <div class="reconciliation-copy">
              <div class="task-title">${primary}</div>
              <div class="application-title">${secondary}</div>
            </div>
          </div>
          <span class="status-chip ${application.status}">${applicationStatusLabel(application.status)}</span>
        </div>
        <div class="meta-row">
          ${applicationMetaChips(application)}
        </div>
        ${applicationResultSummary(application) ? `<div class="application-meta">${escapeHtml(applicationResultSummary(application))}</div>` : ""}
        ${expanded ? reconciliationDetails(application) : ""}
      </div>
    </div>
  `;
}

function sortByStartAsc(items) {
  return [...items].sort((left, right) => new Date(left.start).getTime() - new Date(right.start).getTime());
}

function sortByStartDesc(items) {
  return [...items].sort((left, right) => new Date(right.start).getTime() - new Date(left.start).getTime());
}

function studentRoutineSortKey(student) {
  const weekday = Number.isInteger(student.routineProfile?.weekday) ? student.routineProfile.weekday : 99;
  const time = student.routineProfile?.time || "99:99";
  return { weekday, time };
}

function compareStudents(left, right) {
  const leftHasNext = Boolean(left.nextSession);
  const rightHasNext = Boolean(right.nextSession);
  if (leftHasNext !== rightHasNext) {
    return leftHasNext ? -1 : 1;
  }

  const leftRoutine = studentRoutineSortKey(left);
  const rightRoutine = studentRoutineSortKey(right);
  if (leftRoutine.weekday !== rightRoutine.weekday) {
    return leftRoutine.weekday - rightRoutine.weekday;
  }
  if (leftRoutine.time !== rightRoutine.time) {
    return leftRoutine.time.localeCompare(rightRoutine.time, "ja");
  }

  return left.name.localeCompare(right.name, "ja");
}

function syncSelectedStudent() {
  if (!state.selectedStudentId || !state.students.some((student) => student.id === state.selectedStudentId)) {
    state.selectedStudentId = state.students[0]?.id ?? null;
  }
}

function currentStudent() {
  return state.students.find((student) => student.id === state.selectedStudentId) ?? null;
}

function createStudentDraftMarkup() {
  return `
    <article class="detail-card student-create-card">
      <div class="student-create-head">
        <div>
          <p class="eyebrow">Student</p>
          <h3 class="student-detail-name">新規生徒</h3>
        </div>
      </div>
      <div class="student-create-grid">
        <div class="student-create-field">
          <p class="metric-label">生徒名</p>
          <input class="inline-input" id="new-student-name" type="text" placeholder="生徒名" />
        </div>
        <div class="student-create-field">
          <p class="metric-label">生徒コード</p>
          <input class="inline-input" id="new-student-code" type="text" placeholder="生徒コード" />
        </div>
        <div class="student-create-field">
          <p class="metric-label">コース</p>
          <select class="inline-input" id="new-student-course">
            <option value="unknown">コース</option>
            <option value="standard">スタンダード</option>
            <option value="advance">アドバンス</option>
            <option value="premium">プレミアム</option>
            <option value="chat_support">チャットサポート</option>
          </select>
        </div>
        <div class="student-create-field">
          <p class="metric-label">担当内容</p>
          <select class="inline-input" id="new-student-teaching">
            <option value="unknown">担当内容</option>
            <option value="coaching_only">通常コーチング</option>
            <option value="essay_teaching">小論文ティーチング</option>
            <option value="past_exam_teaching">過去問ティーチング</option>
            <option value="subject_teaching">科目ティーチング</option>
          </select>
        </div>
        <div class="student-create-inline">
          <div class="student-create-field">
            <p class="metric-label">曜日</p>
            <select class="inline-input inline-input-compact routine-select-weekday" id="new-student-weekday">
              <option value="">曜</option>
              ${[0, 1, 2, 3, 4, 5, 6].map((weekday) => `<option value="${weekday}">${weekdayLabel(weekday)}</option>`).join("")}
            </select>
          </div>
          <div class="student-create-field">
            <p class="metric-label">時間</p>
            <input class="inline-input inline-input-time routine-time-input" id="new-student-time" type="time" />
          </div>
        </div>
      </div>
      <div class="student-create-actions">
        <button class="primary student-create-submit" data-create-student type="button">登録</button>
      </div>
    </article>
  `;
}

function inboxItems() {
  return state.applications
    .filter((application) =>
      application.source === "gmail"
      || application.completionState === "missing"
      || application.completionState === "partial"
      || ["draft", "review", "stale"].includes(application.status),
    )
    .sort((left, right) => {
      const priority = {
        missing: 0,
        partial: 1,
        stale: 2,
        review: 3,
        draft: 4,
      };
      const leftKey = left.source === "gmail" ? "review" : (left.completionState || left.status);
      const rightKey = right.source === "gmail" ? "review" : (right.completionState || right.status);
      return (priority[leftKey] ?? 9) - (priority[rightKey] ?? 9)
        || applicationIssuePriority(left) - applicationIssuePriority(right)
        || new Date(left.start).getTime() - new Date(right.start).getTime();
    });
}

function reconcileItems() {
  return state.applications
    .filter((application) =>
      application.source === "gmail"
      || application.completionState === "partial",
    )
    .sort((left, right) => {
      const priority = {
        gmail: 0,
        partial: 1,
      };
      const leftKey = left.source === "gmail" ? "gmail" : "partial";
      const rightKey = right.source === "gmail" ? "gmail" : "partial";
      return (priority[leftKey] ?? 9) - (priority[rightKey] ?? 9)
        || new Date(left.start).getTime() - new Date(right.start).getTime();
    })
    .slice(0, 8);
}

function todaysSessionsCount() {
  const todayKey = new Date().toISOString().slice(0, 10);
  return state.applications.filter((application) => application.start.slice(0, 10) === todayKey).length;
}

function unmatchedSubmissionCount() {
  return state.applications.filter((application) => application.source === "gmail" && application.status === "review").length;
}

function renderServiceCard(root, accounts, purpose, label) {
  const connectedAccount = accounts.find((account) => account.connected) ?? null;
  const helperText = purpose === "gmail"
    ? "@gyakuten-coaching.com の Gmail アカウントを接続してください。"
    : "逆転コーチングの予定が入っているカレンダーを持つ Google アカウントを接続してください。予定が無い場合は、載せたいカレンダーを持つアカウントを接続してください。";
  root.innerHTML = `
    <div class="service-card">
      <div class="service-head">
        <div class="service-title ${connectedAccount ? "is-on" : ""}">${label}</div>
        ${connectedAccount
          ? `<button data-purpose="${purpose}" data-account-id="${connectedAccount.id}" class="disconnect secondary service-card-action is-on">解除</button>`
          : `<button data-connect-purpose="${purpose}" class="secondary service-card-action is-off">接続</button>`}
      </div>
      ${connectedAccount
        ? `
          <div class="account-primary">${escapeHtml(connectedAccount.email || connectedAccount.id)}</div>
          <div class="account-secondary">接続済み</div>
        `
        : `<div class="account-secondary">まだ接続されていません。</div>`}
      <div class="service-help">${escapeHtml(helperText)}</div>
    </div>
  `;
}

function renderCalendarPicker(calendars) {
  const root = $("#settings-calendar-picker");
  if (!calendars.length) {
    root.innerHTML = "<p class='muted'>表示できるカレンダーがありません。</p>";
    $("#calendar-selection-summary").textContent = "0件";
    return;
  }

  const persisted = new Set(loadPersistedSelection());
  const fallbackSelection = defaultSelectedCalendars(calendars, persisted);

  root.innerHTML = calendars.map((calendar) => `
    <label class="calendar-option">
      <input type="checkbox" value="${calendar.id}" ${fallbackSelection.has(calendar.id) ? "checked" : ""} />
      <span class="dot" style="background:${calendar.backgroundColor || "#2563eb"}"></span>
      <span>
        <span class="calendar-option-primary">${escapeHtml(calendar.summary)}</span>
        <span class="calendar-option-secondary">${escapeHtml(calendar.accountEmail)}</span>
      </span>
    </label>
  `).join("");

  persistSelectedCalendarIds(selectedCalendarIds());
  $("#calendar-selection-summary").textContent = `${selectedCalendarIds().length}件`;
}

function updateConnectionStatus(gmailAccounts, calendarAccounts) {
  if (!state.me) {
    $("#settings-status-dot")?.classList.remove("warning", "ok");
    return;
  }
  const gmailReady = gmailAccounts.some((account) => account.connected);
  const calendarReady = calendarAccounts.some((account) => account.connected);

  const dot = $("#settings-status-dot");

  dot.classList.remove("warning", "ok");

  if (gmailReady && calendarReady) {
    dot.classList.add("ok");
  } else if (gmailReady || calendarReady) {
    dot.classList.add("warning");
  }
}

function renderHeader() {
}

function renderAuthGate() {
  const gate = $("#auth-gate");
  const workspace = $(".workspace");
  const authSummary = $("#auth-user-summary");
  const authHint = $("#auth-user-hint");
  const logoutButton = $("#logout-button");
  if (authSummary) {
    authSummary.textContent = state.me ? `${state.me.name} (${state.me.email})` : "未ログイン";
  }
  if (authHint) {
    authHint.textContent = state.me ? "本人の設定と接続のみ表示します。" : "Google ログインで本人データを読み込みます。";
  }
  if (logoutButton) {
    logoutButton.hidden = !state.me;
  }
  if (!gate || !workspace) {
    return;
  }
  if (!state.authLoaded) {
    gate.hidden = false;
    gate.innerHTML = `
      <section class="panel auth-card">
        <p class="eyebrow">Auth</p>
        <h3>ログイン状態を確認しています</h3>
        <p class="muted">しばらく待っても進まない場合はページを再読み込みしてください。</p>
      </section>
    `;
    workspace.hidden = true;
    return;
  }
  if (!state.me) {
    gate.hidden = false;
    gate.innerHTML = `
      <section class="panel auth-card">
        <p class="eyebrow">Coach Access</p>
        <h3>Google ログインが必要です</h3>
        <p class="muted">ログイン後は、あなた自身の設定・Google 接続・申請一覧だけを表示します。</p>
        <div class="button-row">
          <button id="start-auth-google" class="primary" type="button">Google ログイン</button>
        </div>
      </section>
    `;
    workspace.hidden = true;
    return;
  }
  const gmailReady = state.gmailAccounts.some((account) => account.connected);
  const calendarReady = state.calendarAccounts.some((account) => account.connected);
  if (!gmailReady || !calendarReady) {
    gate.hidden = false;
    gate.innerHTML = `
      <section class="panel auth-card">
        <p class="eyebrow">Setup</p>
        <h3>接続がまだ完了していません</h3>
        <p class="muted">このページで Google ログインしたあと、設定から次の 2 つを接続してください。</p>
        <div class="item-stack">
          <article class="task-card">
            <div class="task-title">1. カレンダー接続</div>
            <div class="task-meta">逆転コーチングのスケジュールを載せているカレンダーがあるアカウント、または載せたいカレンダーを持つアカウントを接続してください。</div>
          </article>
          <article class="task-card">
            <div class="task-title">2. Gmail 接続</div>
            <div class="task-meta">@gyakuten-coaching.com のアカウントを接続してください。</div>
          </article>
        </div>
      </section>
    `;
    workspace.hidden = false;
    return;
  }
  gate.hidden = true;
  gate.innerHTML = "";
  workspace.hidden = false;
}

function renderMetrics() {
  if (!state.me) {
    $("#nav-meta-calendar").textContent = "0件";
    $("#nav-meta-students").textContent = "0人";
    $("#nav-meta-applications").textContent = "0件";
    return;
  }
  const unresolvedApplicationCount = unresolvedApplications().length;
  const unresolvedCalendarCount = unresolvedCalendarApplications().length;
  $("#nav-meta-calendar").textContent = state.studentsLoaded || state.students.length > 0
    ? `${unresolvedCalendarCount}件`
    : state.calendars.length > 0 ? "…" : "0件";
  $("#nav-meta-students").textContent = state.studentsLoaded || state.students.length > 0
    ? `${state.students.length}人`
    : state.calendars.length > 0 ? "…" : "0人";
  $("#nav-meta-applications").textContent = state.applicationsLoaded || state.applications.length > 0
    ? `${unresolvedApplicationCount}件`
    : state.calendars.length > 0 ? "…" : "0件";
}

function renderInbox() {
  const inbox = inboxItems();
  $("#inbox-list").innerHTML = inbox.length > 0
    ? inbox.map((item) => `
      <article class="task-card">
        <div class="task-top">
          <div class="task-body">
            <div class="task-title">${renderNameText(item.studentName)}</div>
            <div class="meta-row">
              ${applicationMetaChips(item)}
              <span class="task-meta">${escapeHtml(item.title)}</span>
            </div>
            <div class="task-reason">${escapeHtml(item.attentionReason || "")}</div>
          </div>
          <span class="status-chip ${item.status}">${applicationStatusLabel(item.status)}</span>
        </div>
        <div class="task-meta">${formatDateTime(item.start)}</div>
      </article>
    `).join("")
    : "<p class='muted'>要対応の申請はありません。</p>";

  const reconcile = reconcileItems();
  $("#upcoming-list").innerHTML = reconcile.length > 0
    ? reconcile.map((item) => `
      <article class="session-card">
        <div class="task-title">${renderNameText(item.studentName)}</div>
        <div class="meta-row">
          ${applicationMetaChips(item)}
          <span class="task-meta">${formatDateTime(item.start)}</span>
        </div>
        <div class="task-meta">${escapeHtml(item.attentionReason || item.title)}</div>
      </article>
    `).join("")
    : "<p class='muted'>照合漏れはありません。</p>";
}

function renderStudents() {
  const listHead = document.querySelector("#view-students .student-list-panel .panel-head");
  if (listHead) {
    listHead.innerHTML = `
      <div>
        <p class="eyebrow">Students</p>
        <h3>生徒一覧</h3>
      </div>
      <div class="student-toolbar">
        <button class="secondary" data-open-create-student type="button">新規生徒</button>
      </div>
    `;
  }

  if (state.studentsLoading && state.students.length === 0) {
    $("#student-list").innerHTML = "<p class='muted'>生徒データを読み込み中です。</p>";
    $("#student-detail").innerHTML = "<p class='muted'>生徒データを読み込み中です。</p>";
    return;
  }
  if (state.studentsError && state.students.length === 0) {
    $("#student-list").innerHTML = `<p class='muted'>生徒データを読み込めませんでした。${escapeHtml(state.studentsError)}</p>`;
    $("#student-detail").innerHTML = "<p class='muted'>生徒データを読み込めませんでした。</p>";
    return;
  }

  const query = $("#student-search").value.trim().toLowerCase();
  const students = state.students
    .filter((student) => student.name.toLowerCase().includes(query))
    .sort(compareStudents);

  $("#student-list").innerHTML = students.length > 0
    ? students.map((student) => `
      <button class="student-row ${student.id === state.selectedStudentId ? "active" : ""}" data-student-id="${escapeHtml(student.id)}" type="button">
        <div>
          <div class="student-name">${renderNameText(student.name)}</div>
          <div class="student-meta">
            次回 ${student.nextSession ? formatDateOnly(student.nextSession.start) : "未定"}
          </div>
        </div>
        <div class="student-row-meta student-meta">
          <span>未処理 ${student.pendingCount}</span>
        </div>
      </button>
    `).join("")
    : "<p class='muted'>該当する生徒がいません。</p>";

  if (state.selectedStudentId === NEW_STUDENT_ID) {
    $("#student-detail").innerHTML = createStudentDraftMarkup();
    return;
  }

  const student = currentStudent();
  if (!student) {
    $("#student-detail").innerHTML = "<p class='muted'>生徒を選択してください。</p>";
    return;
  }

  const recentStudentSessions = [...student.sessions]
    .sort((left, right) => new Date(right.start).getTime() - new Date(left.start).getTime())
    .slice(0, 6);
  const profile = student.routineProfile;
  const editingStudentName = state.editingStudentNameId === student.id;

  $("#student-detail").innerHTML = `
    <article class="detail-card student-overview-card">
      <div class="student-summary-half">
        <div class="student-header-edit">
          <p class="eyebrow">Student</p>
          <div class="student-title-row">
            ${editingStudentName ? `
              <input
                class="inline-input student-name-input"
                data-student-display-name="${escapeAttr(student.id)}"
                type="text"
                value="${escapeAttr(student.name)}"
                placeholder="生徒名"
              />
            ` : `<h3 class="student-detail-name">${renderNameText(student.name, "name-track student-name-track")}</h3>`}
            <button class="icon-button subtle-icon-button" data-edit-student-name="${escapeAttr(student.id)}" type="button" aria-label="生徒名を編集">${pencilIconMarkup()}</button>
          </div>
        </div>
        <div class="student-summary-grid">
          <div class="detail-stat">
            <div class="metric-label">未処理</div>
            <div class="detail-stat-value">${student.pendingCount}</div>
          </div>
          <div class="detail-stat">
            <div class="metric-label">送信済み</div>
            <div class="detail-stat-value">${student.submittedCount ?? 0}</div>
          </div>
        </div>
      </div>
      <div class="student-routine-half">
        <p class="eyebrow">Routine</p>
        <div class="routine-grid">
          <select class="inline-input routine-select-course" data-student-routine-course="${escapeAttr(student.id)}">
            ${[
              ["unknown", "コース"],
              ["standard", "スタンダード"],
              ["advance", "アドバンス"],
              ["premium", "プレミアム"],
              ["chat_support", "チャットサポート"],
            ].map(([value, label]) => `<option value="${value}" ${profile?.course === value ? "selected" : ""}>${label}</option>`).join("")}
          </select>
          <select class="inline-input routine-select-teaching" data-student-routine-teaching="${escapeAttr(student.id)}">
            ${[
              ["unknown", "担当内容"],
              ["coaching_only", "通常コーチング"],
              ["essay_teaching", "小論文ティーチング"],
              ["past_exam_teaching", "過去問ティーチング"],
              ["subject_teaching", "科目ティーチング"],
            ].map(([value, label]) => `<option value="${value}" ${profile?.teachingType === value ? "selected" : ""}>${label}</option>`).join("")}
          </select>
          <select class="inline-input inline-input-compact routine-select-weekday" data-student-routine-weekday="${escapeAttr(student.id)}">
            <option value="">曜日</option>
            ${[0, 1, 2, 3, 4, 5, 6].map((weekday) => `<option value="${weekday}" ${profile?.weekday === weekday ? "selected" : ""}>${weekdayLabel(weekday)}</option>`).join("")}
          </select>
          <input class="inline-input inline-input-time routine-time-input" data-student-routine-time="${escapeAttr(student.id)}" type="time" value="${escapeAttr(profile?.time || "")}" />
        </div>
      </div>
    </article>

    <article class="detail-card">
      <p class="eyebrow">Applications</p>
        <div class="item-stack">
        ${recentStudentSessions.length > 0 ? recentStudentSessions.map((item) => renderReconciliationRow(item, { datePrimary: true })).join("") : "<p class='muted'>まだ申請候補がありません。</p>"}
      </div>
    </article>
  `;
}

function renderApplicationFilters() {
  const visibleApplications = state.applications;
  const countForFilter = (filterId) => {
    if (filterId === "all") {
      return visibleApplications.filter((application) => application.status !== "upcoming").length;
    }
    if (filterId === "review") {
      return visibleApplications.filter((application) => ["draft", "review"].includes(application.status)).length;
    }
    return visibleApplications.filter((application) => application.status === filterId).length;
  };

  $("#application-filters").innerHTML = APPLICATION_FILTERS.map((filter) => `
    <button
      class="application-filter ${filter.id === state.applicationFilter ? "active" : ""}"
      data-application-filter="${filter.id}"
      type="button"
    >
      ${filter.label} ${countForFilter(filter.id)}
    </button>
  `).join("");
}

function renderApplications() {
  if (state.applicationsLoading && state.applications.length === 0) {
    $("#application-table").innerHTML = "<p class='muted'>申請データを読み込み中です。</p>";
    return;
  }
  if (state.applicationsError && state.applications.length === 0) {
    $("#application-table").innerHTML = `<p class='muted'>申請データを読み込めませんでした。${escapeHtml(state.applicationsError)}</p>`;
    return;
  }

  const baseApplications = state.applications.filter((application) => application.status !== "upcoming");
  const filteredApplications = state.applicationFilter === "all"
    ? baseApplications
    : state.applicationFilter === "review"
      ? baseApplications.filter((application) => ["draft", "review"].includes(application.status))
      : baseApplications.filter((application) => application.status === state.applicationFilter);
  const applications = [...filteredApplications].sort((left, right) => {
    return applicationIssuePriority(left) - applicationIssuePriority(right)
      || new Date(right.start).getTime() - new Date(left.start).getTime();
  });

  $("#application-table").innerHTML = applications.length > 0
    ? applications.map((application) => renderReconciliationRow(application, { datePrimary: true })).join("")
    : "<p class='muted'>表示できる申請がありません。</p>";
}

function renderNavigation() {
  document.querySelectorAll(".nav-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === state.activeView);
  });
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("active", view.id === `view-${state.activeView}`);
  });
  if (state.activeView === "calendar") {
    requestAnimationFrame(() => {
      syncCalendarSplitLayout();
      syncCalendarLayout();
      const calendar = ensureCalendar();
      calendar.render();
      calendar.updateSize();
      calendar.refetchEvents();
    });
  }
}

function syncCalendarLayout() {
  const panel = $("#calendar-panel");
  const shell = $("#calendar-shell");
  if (!panel || !shell) {
    return 320;
  }
  syncCalendarSplitLayout();
  const panelStyles = window.getComputedStyle(panel);
  const shellStyles = window.getComputedStyle(shell);
  const panelPadding =
    parseFloat(panelStyles.paddingTop) +
    parseFloat(panelStyles.paddingBottom);
  const shellMargin =
    parseFloat(shellStyles.marginTop) +
    parseFloat(shellStyles.marginBottom);
  const headHeight = panel.querySelector(".panel-head")?.getBoundingClientRect().height ?? 0;
  const available = panel.clientHeight - panelPadding - headHeight - shellMargin;
  const targetHeight = Math.max(320, Math.floor(available));
  shell.style.height = `${targetHeight}px`;
  return targetHeight;
}

function ensureCalendar() {
  if (state.calendar) {
    return state.calendar;
  }

  state.calendar = new FullCalendar.Calendar($("#calendar-shell"), {
    locale: "ja",
    initialView: "dayGridMonth",
    height: "100%",
    allDaySlot: false,
    eventDisplay: "block",
    headerToolbar: {
      left: "prev,next today",
      center: "title",
      right: "dayGridMonth,timeGridWeek",
    },
    nowIndicator: true,
    navLinks: true,
    datesSet(info) {
      prefetchCalendarWindow(info.startStr, info.endStr, 1);
    },
    eventTimeFormat: {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    },
    eventContent(info) {
      const wrapper = document.createElement("div");
      wrapper.className = "gc-calendar-event";

      if (info.timeText && info.view.type !== "timeGridWeek") {
        const time = document.createElement("span");
        time.className = "gc-calendar-event-time";
        time.textContent = info.timeText;
        wrapper.append(time);
      }

      const title = document.createElement("span");
      title.className = "gc-calendar-event-title";
      title.textContent = info.event.title;
      wrapper.append(title);

      return { domNodes: [wrapper] };
    },
    eventDidMount(info) {
      const bg = info.event.backgroundColor || info.event.extendedProps?.backgroundColor;
      const border = info.event.borderColor || info.event.extendedProps?.borderColor || bg;
      const text = info.event.textColor || info.event.extendedProps?.textColor || "#111111";
      if (bg) {
        info.el.style.backgroundColor = bg;
      }
      if (border) {
        info.el.style.borderColor = border;
      }
      info.el.style.color = text;
      info.el.querySelectorAll(".fc-event-main, .fc-event-time, .fc-event-title, .fc-list-event-title a, .fc-list-event-time, .gc-calendar-event-time, .gc-calendar-event-title").forEach((node) => {
        node.style.color = text;
      });
    },
    events: async (info, successCallback, failureCallback) => {
      try {
        const expandedRange = expandedCalendarRange(info.startStr, info.endStr, 1);
        const cachedEvents = getCachedCalendarEvents(expandedRange.start, expandedRange.end);
        if (cachedEvents) {
          successCallback(visibleCalendarEvents(filterCalendarEventsForRange(cachedEvents, info.startStr, info.endStr)));
          return;
        }
        const events = await fetchCalendarEvents(expandedRange.start, expandedRange.end);
        successCallback(visibleCalendarEvents(filterCalendarEventsForRange(events, info.startStr, info.endStr)));
      } catch (error) {
        failureCallback(error);
      }
    },
    eventClick(info) {
      info.jsEvent.preventDefault();
      void openCalendarDetail(
        info.event.id,
        info.view.activeStart.toISOString(),
        info.view.activeEnd.toISOString(),
      );
    },
  });
  return state.calendar;
}

async function loadConfig() {
  const payload = await request("/api/config");
  $("#credentials-path").value = payload.config.googleOAuth.clientCredentialsPath || "";
  $("#coach-name").value = payload.config.coachProfile?.name || "";
  $("#coach-code").value = payload.config.coachProfile?.code || "";
  $("#coach-email").value = payload.config.coachProfile?.email || "";
}

async function loadCurrentUser() {
  const payload = await request("/api/me");
  state.me = payload.user || null;
}

async function loadStatus() {
  const payload = await request("/api/google/status");
  state.gmailAccounts = payload.gmailAccounts || [];
  state.calendarAccounts = payload.calendarAccounts || [];
  renderServiceCard($("#gmail-service"), payload.gmailAccounts, "gmail", "Gmail");
  renderServiceCard($("#calendar-service"), payload.calendarAccounts, "calendar", "Calendar");
  updateConnectionStatus(payload.gmailAccounts, payload.calendarAccounts);
  if ($("#coach-email") && !$("#coach-email").value.trim()) {
    const connectedGmail = (payload.gmailAccounts || []).find((account) => account.connected);
    if (connectedGmail?.email) {
      $("#coach-email").value = connectedGmail.email;
    } else if (state.me?.email) {
      $("#coach-email").value = state.me.email;
    }
  }
  if ($("#coach-name") && !$("#coach-name").value.trim() && state.me?.name) {
    $("#coach-name").value = state.me.name;
  }
  renderAuthGate();
}

async function saveConfig() {
  const clientCredentialsPath = $("#credentials-path").value.trim();
  const coachName = $("#coach-name").value.trim();
  const coachCode = $("#coach-code").value.trim();
  const coachEmail = $("#coach-email").value.trim();
  await request("/api/config", {
    method: "POST",
    body: JSON.stringify({
      coachProfile: {
        name: coachName,
        code: coachCode,
        email: coachEmail,
      },
      googleOAuth: {
        clientCredentialsPath,
      },
    }),
  });
}

function scheduleConfigSave() {
  if (configSaveTimer) {
    window.clearTimeout(configSaveTimer);
  }
  configSaveTimer = window.setTimeout(async () => {
    await saveConfig();
    setUploadNote("設定を保存しました");
  }, 300);
}

async function uploadOAuthJson(file) {
  const contents = await file.text();
  const payload = await request("/api/config/oauth-json", {
    method: "POST",
    body: JSON.stringify({ contents }),
  });
  $("#credentials-path").value = payload.savedPath;
  setUploadNote(`${file.name} を保存しました`);
}

async function connectGoogle(purpose) {
  const clientCredentialsPath = $("#credentials-path").value.trim();
  const payload = await request("/api/google/start", {
    method: "POST",
    body: JSON.stringify({
      purpose,
      clientCredentialsPath,
    }),
  });

  window.open(payload.authorizationUrl, "_blank", "noopener");
  await request(`/api/google/wait?state=${encodeURIComponent(payload.state)}`);
  await loadStatus();
  await loadCalendars();
}

async function disconnectGoogle(purpose, accountId) {
  await request("/api/google/disconnect", {
    method: "POST",
    body: JSON.stringify({ purpose, accountId }),
  });
  await loadStatus();
  await loadCalendars();
}

async function startGoogleLogin() {
  const payload = await request("/api/auth/google/start", {
    method: "POST",
    body: JSON.stringify({}),
  });
  window.location.assign(payload.authorizationUrl);
}

async function logout() {
  await request("/api/auth/logout", {
    method: "POST",
    body: JSON.stringify({}),
  });
  resetAuthenticatedState();
  state.authLoaded = true;
  renderAllViews();
}

async function loadCalendars() {
  clearCalendarEventCache();
  const payload = await request("/api/google/calendars");
  state.calendars = payload.calendars;
  clearCalendarDetail();
  state.studentsLoaded = false;
  state.applicationsLoaded = false;
  state.staleNotificationBlockedKey = "";
  renderCalendarPicker(state.calendars);
  renderFiscalYearPicker();
  renderAllViews();
  if (selectedCalendarIds().length === 0) {
    state.students = [];
    state.applications = [];
    state.studentsLoaded = true;
    state.applicationsLoaded = true;
    renderAllViews();
    return;
  }
  if (state.activeView === "calendar") {
    syncCalendarLayout();
    const calendar = ensureCalendar();
    calendar.render();
    calendar.updateSize();
    calendar.refetchEvents();
  } else if (state.activeView === "students") {
    void ensureStudentsData(true);
  } else if (state.activeView === "applications") {
    void ensureApplicationsData(true);
  }
}

async function fetchSummary(start, end) {
  return request(
    `/api/workspace/summary?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&calendarIds=${encodeURIComponent(selectedCalendarIds().join(","))}`,
  );
}

function isRateLimitError(error) {
  return /rate limit|rate-limit|User-rate limit exceeded|Retry after/i.test(String(error?.message || error || ""));
}

async function loadStudentsData() {
  state.studentsError = "";
  if (!state.calendars.length || selectedCalendarIds().length === 0) {
    state.students = [];
    state.studentsLoaded = true;
    syncSelectedStudent();
    renderAllViews();
    return;
  }

  const range = selectedFiscalYearRange();
  const payload = await fetchSummary(range.start, range.end);
  state.students = payload.students ?? [];
  state.studentsLoaded = true;
  saveSummarySnapshot(studentsSnapshotStorageKey, {
    calendarIds: selectedCalendarIds().slice().sort(),
    start: range.start,
    end: range.end,
  }, state.students);
  syncSelectedStudent();
  syncSelectedCalendarRecord();
  renderAllViews();
}

async function loadApplicationsData() {
  state.applicationsError = "";
  if (!state.calendars.length || selectedCalendarIds().length === 0) {
    state.applications = [];
    state.applicationsLoaded = true;
    renderAllViews();
    return;
  }

  const { start, end } = overviewRangeToIso();
  const payload = await fetchSummary(start, end);
  state.applications = payload.applications ?? [];
  state.applicationsLoaded = true;
  saveSummarySnapshot(applicationsSnapshotStorageKey, {
    calendarIds: selectedCalendarIds().slice().sort(),
    start,
    end,
  }, state.applications);
  syncSelectedCalendarRecord();
  renderAllViews();
}

async function ensureStudentsData(force = false) {
  if (!force && state.studentsLoaded) {
    return;
  }
  if (!force && state.studentsLoading) {
    await state.studentsLoading;
    return;
  }

  state.studentsLoading = loadStudentsData()
    .catch((error) => {
      state.studentsLoaded = false;
      const range = selectedFiscalYearRange();
      const snapshot = loadSummarySnapshot(studentsSnapshotStorageKey, {
        calendarIds: selectedCalendarIds().slice().sort(),
        start: range.start,
        end: range.end,
      });
      if (snapshot) {
        state.students = snapshot;
        state.studentsLoaded = true;
        state.studentsError = "";
        syncSelectedStudent();
        syncSelectedCalendarRecord();
        if (isRateLimitError(error)) {
          showToast("Google 側のレート制限中です。生徒一覧は前回の表示を復元しました。", "warning");
        }
        renderAllViews();
        return;
      }
      if (state.students.length > 0) {
        state.studentsLoaded = true;
        state.studentsError = "";
        if (isRateLimitError(error)) {
          showToast("Google 側のレート制限中です。生徒一覧は前回の表示を維持しています。", "warning");
        }
        renderAllViews();
        return;
      }
      state.students = [];
      state.studentsError = error instanceof Error ? error.message : "生徒データを取得できませんでした。";
      renderAllViews();
    })
    .finally(() => {
      state.studentsLoading = null;
      renderAllViews();
    });
  await state.studentsLoading;
}

async function ensureApplicationsData(force = false) {
  if (!force && state.applicationsLoaded) {
    return;
  }
  if (!force && state.applicationsLoading) {
    await state.applicationsLoading;
    return;
  }

  state.applicationsLoading = loadApplicationsData()
    .catch((error) => {
      state.applicationsLoaded = false;
      const { start, end } = overviewRangeToIso();
      const snapshot = loadSummarySnapshot(applicationsSnapshotStorageKey, {
        calendarIds: selectedCalendarIds().slice().sort(),
        start,
        end,
      });
      if (snapshot) {
        state.applications = snapshot;
        state.applicationsLoaded = true;
        state.applicationsError = "";
        syncSelectedCalendarRecord();
        if (isRateLimitError(error)) {
          showToast("Google 側のレート制限中です。申請一覧は前回の表示を復元しました。", "warning");
        }
        renderAllViews();
        return;
      }
      if (state.applications.length > 0) {
        state.applicationsLoaded = true;
        state.applicationsError = "";
        if (isRateLimitError(error)) {
          showToast("Google 側のレート制限中です。申請一覧は前回の表示を維持しています。", "warning");
        }
        renderAllViews();
        return;
      }
      state.applications = [];
      state.applicationsError = error instanceof Error ? error.message : "申請データを取得できませんでした。";
      renderAllViews();
    })
    .finally(() => {
      state.applicationsLoading = null;
      renderAllViews();
    });
  await state.applicationsLoading;
}

async function triggerStaleNotification() {
  return;
}

function findReconciliationById(id) {
  return state.applications.find((item) => item.id === id)
    || state.students.flatMap((student) => student.sessions || []).find((item) => item.id === id)
    || (state.selectedCalendarRecord?.id === id ? state.selectedCalendarRecord : null)
    || null;
}

async function saveReconciliationOverride(id) {
  try {
    const studentInput = document.querySelector(`[data-override-student-name="${CSS.escape(id)}"]`);
    const kindInput = document.querySelector(`[data-override-kind="${CSS.escape(id)}"]`);
    const nextStudentName = studentInput?.value?.trim() || undefined;
    const nextKind = kindInput?.value || undefined;
    applyLocalReconciliationMutation(id, (record) => ({
      ...record,
      studentName: nextStudentName ? displayStudentName(nextStudentName) : record.studentName,
      kind: nextKind || record.kind,
    }));
    renderAllViews();
    await request(`/api/reconciliations/${encodeURIComponent(id)}/override`, {
      method: "POST",
      body: JSON.stringify({
        studentName: nextStudentName,
        kind: nextKind,
      }),
    });
    markSummaryDirty();
    void refreshVisibleData();
  } catch (error) {
    noteError(error);
    markSummaryDirty();
    void refreshVisibleData();
  }
}

async function ignoreReconciliation(id) {
  try {
    let nextRecord = null;
    applyLocalReconciliationMutation(id, (record) => {
      nextRecord = {
        ...record,
        lastActiveStatus: deriveRestoredReconciliationStatus(record),
        ignored: true,
        status: "ignored",
      };
      return nextRecord;
    });
    if (nextRecord) {
      applyCalendarEventVisualState(nextRecord);
    }
    renderAllViews();
    await request(`/api/reconciliations/${encodeURIComponent(id)}/ignore`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    markSummaryDirty();
    queueImmediateRealtimeRefresh();
  } catch (error) {
    noteError(error);
    markSummaryDirty();
    queueImmediateRealtimeRefresh();
  }
}

async function restoreReconciliation(id) {
  try {
    let nextRecord = null;
    applyLocalReconciliationMutation(id, (record) => {
      nextRecord = {
        ...record,
        ignored: false,
        status: deriveRestoredReconciliationStatus(record),
      };
      return nextRecord;
    });
    if (nextRecord) {
      applyCalendarEventVisualState(nextRecord);
    }
    renderAllViews();
    await request(`/api/reconciliations/${encodeURIComponent(id)}/restore`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    markSummaryDirty();
    queueImmediateRealtimeRefresh();
  } catch (error) {
    noteError(error);
    markSummaryDirty();
    queueImmediateRealtimeRefresh();
  }
}

async function invalidateSubmission(id) {
  try {
    applyLocalSubmissionInvalidation(id);
    renderAllViews();
    await request(`/api/submissions/${encodeURIComponent(id)}/invalidate`, {
      method: "POST",
      body: JSON.stringify({ invalidated: true }),
    });
    markSummaryDirty();
    queueImmediateRealtimeRefresh();
  } catch (error) {
    noteError(error);
    markSummaryDirty();
    queueImmediateRealtimeRefresh();
  }
}

async function saveCalendarTitleForReconciliation(id) {
  try {
    const record = findReconciliationById(id);
    const titleInput = document.querySelector(`[data-calendar-title="${CSS.escape(id)}"]`);
    if (!record?.calendarEvent || !titleInput?.value?.trim() || titleInput.value.trim() === record.calendarEvent.title) {
      return;
    }
    const nextTitle = titleInput.value.trim();
    applyLocalReconciliationMutation(id, (item) => ({
      ...item,
      title: nextTitle,
      calendarEvent: item.calendarEvent
        ? {
            ...item.calendarEvent,
            title: nextTitle,
          }
        : item.calendarEvent,
    }));
    state.calendar?.getEventById(record.calendarEvent.id)?.setProp("title", nextTitle);
    renderAllViews();
    await request(`/api/calendar-sessions/${encodeURIComponent(record.calendarEvent.id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        accountId: record.calendarEvent.accountId,
        googleCalendarId: record.calendarEvent.googleCalendarId,
        googleEventId: record.calendarEvent.googleEventId,
        title: nextTitle,
      }),
    });
    markSummaryDirty();
    void refreshVisibleData({ refetchCalendar: true });
  } catch (error) {
    noteError(error);
    markSummaryDirty();
    void refreshVisibleData({ refetchCalendar: true });
  }
}

async function deleteCalendarForReconciliation(id) {
  try {
    const record = findReconciliationById(id);
    if (!record?.calendarEvent) {
      return;
    }
    state.calendar?.getEventById(record.calendarEvent.id)?.remove();
    removeLocalCalendarRecordByEventId(record.calendarEvent.id);
    renderAllViews();
    await request(`/api/calendar-sessions/${encodeURIComponent(record.calendarEvent.id)}`, {
      method: "DELETE",
      body: JSON.stringify({
        accountId: record.calendarEvent.accountId,
        googleCalendarId: record.calendarEvent.googleCalendarId,
        googleEventId: record.calendarEvent.googleEventId,
      }),
    });
    markSummaryDirty();
    void refreshVisibleData({ refetchCalendar: true });
  } catch (error) {
    noteError(error);
    markSummaryDirty();
    void refreshVisibleData({ refetchCalendar: true });
  }
}

async function runAutofillForReconciliation(id) {
  const record = findReconciliationById(id);
  if (!record) {
    showToast("照合結果を見つけられませんでした。", "error");
    return;
  }
  const formItems = applicationRunnableFormItems(record);
  if (formItems.length === 0) {
    if (record.autofillEligibility === "ready" || isPendingAutofillTaskStatus(record.autofillTask?.status)) {
      return runAutofillForReconciliationWithKind(id, record.kind);
    }
    showAutofillBlockedReason(id);
    return;
  }
  const blockedItems = applicationFormItems(record).filter((item) =>
    item.status === "autofill_blocked" && !isMailConfirmationPendingItem(item),
  );
  const runnableKinds = [...new Set(formItems.map((item) => item.kind))];
  if (runnableKinds.length === 0) {
    showAutofillBlockedReason(id);
    return;
  }
  try {
    showToast("送信準備を開始しています...", "warning");
    const openedLabels = [];
    for (const kind of runnableKinds) {
      await runAutofillForReconciliationWithKind(id, kind, { silent: true });
      openedLabels.push(kind === "main" ? "本体申請" : workflowSuggestionLabel(kind));
    }
    if (blockedItems.length > 0) {
      const blockedSummary = blockedItems.map((item) => item.label).join(" / ");
      showToast(`送信準備: ${openedLabels.join(" / ")}。未準備: ${blockedSummary}`, "warning");
    } else {
      showToast(`送信準備: ${openedLabels.join(" / ")}`, "success");
    }
  } catch (error) {
    noteError(error);
  }
}

async function runAutofillForReconciliationWithKind(id, kindOverride, options = {}) {
  const { silent = false } = options;
  try {
    if (!silent) {
      showToast("送信準備ボタンを受け付けました。", "warning");
    }
    const { start, end } = overviewRangeToIso();
    setUploadNote("Chrome で送信準備を開始しています...");
    const runResult = await request("/api/autofill/run", {
      method: "POST",
      body: JSON.stringify({
        reconciliationId: id,
        kindOverride,
        start,
        end,
        calendarIds: selectedCalendarIds(),
      }),
    });
    if (runResult?.task?.status === "awaiting_user_submit") {
      applyLocalAutofillTaskResult(id, kindOverride, runResult.task);
      renderAllViews();
      scheduleAutofillFollowupRefresh();
      if (!silent) {
        showToast("Chrome に送信直前フォームを開きました。内容確認後に送信してください。", "success");
      }
      const note = $("#oauth-upload-note");
      if (note) {
        note.textContent = "Chrome に送信直前フォームを開きました。内容確認後に送信してください。";
      }
    } else if (runResult?.task) {
      applyLocalAutofillTaskResult(id, kindOverride, runResult.task);
      renderAllViews();
    } else {
      if (!silent) {
        showToast(runResult?.task?.lastError || "自動入力を完了できませんでした。", "error");
      }
    }
    markSummaryDirty();
    window.setTimeout(() => {
      void runRealtimeRefresh();
    }, 1200);
  } catch (error) {
    noteError(error);
    markSummaryDirty();
    void runRealtimeRefresh();
  }
}

function showAutofillBlockedReason(id) {
  const record = findReconciliationById(id);
  if (!record) {
    showToast("照合結果を見つけられませんでした。", "error");
    return;
  }
  const messages = [];
  const bundleReason = autofillBlockedBundleReason(record);
  if (bundleReason) {
    messages.push(bundleReason);
  } else if (record.autofillReason && record.autofillReason !== "滞留のみ対象です。") {
    messages.push(record.autofillReason);
  } else {
    messages.push("自動入力の前に補足情報が必要です。");
  }
  if (record.studentCodeCandidate?.studentCode && !record.resolvedStudentCode) {
    messages.push(`候補コード ${record.studentCodeCandidate.studentCode} を台帳へ追加できます。`);
  }
  const text = messages.join(" ");
  setUploadNote(text);
}

async function saveStudentCodeForReconciliation(id) {
  try {
    const record = findReconciliationById(id);
    const manualInput = document.querySelector(`[data-manual-student-code="${CSS.escape(id)}"]`);
    const nextCode = manualInput?.value?.trim() || record?.studentCodeCandidate?.studentCode || "";
    if (!record?.studentKey || !nextCode) {
      showToast("生徒コードを入力してください。", "warning");
      return;
    }
    applyLocalReconciliationMutation(id, (item) => ({
      ...item,
      resolvedStudentCode: nextCode,
      studentCodeCandidate: undefined,
    }));
    renderAllViews();
    await request(`/api/students/${encodeURIComponent(record.studentKey)}/code`, {
      method: "POST",
      body: JSON.stringify({
        studentName: record.studentName,
        studentCode: nextCode,
        evidenceCount: record.studentCodeCandidate?.evidenceCount ?? 0,
      }),
    });
    showToast("生徒コードを台帳に登録しました。", "success");
    markSummaryDirty();
    void refreshVisibleData();
  } catch (error) {
    noteError(error);
    markSummaryDirty();
    void refreshVisibleData();
  }
}

async function applyCalendarSuggestion(id, suggestionId) {
  try {
    const record = findReconciliationById(id);
    const suggestion = record?.calendarSuggestions?.find((item) => item.id === suggestionId);
    if (!record || !suggestion) {
      return;
    }
    const selectionId = selectedCalendarIds()[0] || "";
    const optimisticEventId = suggestion.type === "create" ? `temp:${suggestion.id}:${Date.now()}` : "";
    const optimisticEvent = suggestion.type === "create" && selectionId
      ? buildLocalCalendarEvent(selectionId, {
          id: optimisticEventId,
          googleEventId: "",
          title: suggestion.title,
          start: suggestion.start,
          end: suggestion.end,
        })
      : null;
    if (optimisticEvent) {
      insertLocalCalendarEvent(optimisticEvent);
    }
    setUploadNote(`${calendarSuggestionButtonLabel(suggestion)}中...`);
    const result = await request("/api/calendar-suggestions/apply", {
      method: "POST",
      body: JSON.stringify({
        suggestion,
        selectionId,
      }),
    });
    if (result?.event && selectionId) {
      insertLocalCalendarEvent(buildLocalCalendarEvent(selectionId, {
        ...result.event,
        googleEventId: result.event.extendedProps?.googleEventId || result.event.googleEventId || "",
      }), { replaceId: optimisticEventId || undefined });
    } else if (optimisticEventId) {
      state.calendar?.getEventById(optimisticEventId)?.remove();
    }
    applyLocalCalendarSuggestionResolution(id);
    renderAllViews();
    requestCalendarRelayout();
    setUploadNote(`予定を${calendarSuggestionButtonLabel(suggestion)}しました`);
    markSummaryDirty();
    if (state.activeView === "calendar") {
      await ensureApplicationsData(true);
      renderAllViews();
      requestCalendarRelayout();
    } else if (state.activeView === "applications") {
      await refreshVisibleData({ applications: true, refetchCalendar: true });
    } else {
      void Promise.allSettled([
        ensureApplicationsData(true),
        refreshVisibleData({ refetchCalendar: true }),
      ]);
    }
  } catch (error) {
    const tempIdPrefix = `temp:${suggestionId}:`;
    state.calendar?.getEvents().forEach((event) => {
      if (event.id.startsWith(tempIdPrefix)) {
        event.remove();
      }
    });
    noteError(error);
    markSummaryDirty();
    void refreshVisibleData({ refetchCalendar: true });
  }
}

function scheduleCalendarTitleSave(id) {
  if (calendarTitleSaveTimers.has(id)) {
    window.clearTimeout(calendarTitleSaveTimers.get(id));
  }
  calendarTitleSaveTimers.set(id, window.setTimeout(async () => {
    calendarTitleSaveTimers.delete(id);
    await saveCalendarTitleForReconciliation(id);
  }, 450));
}

function clearCalendarDetail() {
  state.selectedCalendarRecord = null;
  state.calendarDetailLoading = false;
  state.calendarDetailError = "";
  syncCalendarSplitLayout();
  requestCalendarRelayout();
}

async function openCalendarDetail(eventId, rangeStart, rangeEnd) {
  const loaded = findLoadedCalendarRecord(eventId);
  if (loaded) {
    state.selectedCalendarRecord = loaded;
    state.calendarDetailLoading = false;
    state.calendarDetailError = "";
    renderCalendarDetail();
    requestCalendarRelayout();
    return;
  }
  state.calendarDetailLoading = true;
  state.calendarDetailError = "";
  renderCalendarDetail();
  try {
    const payload = await fetchSummary(rangeStart, rangeEnd);
    const record = (payload.applications ?? []).find((item) => item.calendarEvent?.id === eventId || item.sessionIds?.includes(eventId)) || null;
    state.selectedCalendarRecord = record;
  } catch (error) {
    state.calendarDetailError = error instanceof Error ? error.message : "予定詳細を読み込めませんでした。";
  } finally {
    state.calendarDetailLoading = false;
    renderCalendarDetail();
    requestCalendarRelayout();
  }
}

function renderAllViews() {
  renderAuthGate();
  renderHeader();
  renderMetrics();
  renderNavigation();
  if (!state.me) {
    return;
  }
  renderCalendarDetail();
  renderStudents();
  renderApplicationFilters();
  renderApplications();
}

function renderCalendarDetail() {
  const root = $("#calendar-record-detail");
  const pane = $("#calendar-detail-pane");
  if (!root) {
    return;
  }
  if (state.activeView !== "calendar") {
    root.innerHTML = "";
    syncCalendarSplitLayout();
    return;
  }
  if (state.calendarDetailLoading) {
    syncCalendarSplitLayout();
    root.innerHTML = "<p class='muted'>予定詳細を読み込み中です。</p>";
    return;
  }
  if (state.calendarDetailError) {
    syncCalendarSplitLayout();
    root.innerHTML = `<p class='muted'>${escapeHtml(state.calendarDetailError)}</p>`;
    return;
  }
  if (!state.selectedCalendarRecord) {
    root.innerHTML = "";
    pane?.classList.remove("open");
    syncCalendarSplitLayout();
    return;
  }
  syncCalendarSplitLayout();
  root.innerHTML = calendarDetailMarkup(state.selectedCalendarRecord);
}

async function runRealtimeRefresh() {
  if (document.hidden) {
    return;
  }
  if (!state.calendars.length || selectedCalendarIds().length === 0) {
    return;
  }
  if (realtimeRefreshInFlight) {
    return realtimeRefreshInFlight;
  }
  realtimeRefreshInFlight = (async () => {
    try {
      await Promise.allSettled([
        ensureStudentsData(true),
        ensureApplicationsData(true),
      ]);
      if (state.activeView === "calendar" && state.calendar) {
        requestCalendarRelayout(true);
      } else {
        renderAllViews();
      }
    } finally {
      realtimeRefreshInFlight = null;
    }
  })();
  return realtimeRefreshInFlight;
}

function stopRealtimeRefresh() {
  if (realtimeRefreshTimer) {
    window.clearInterval(realtimeRefreshTimer);
    realtimeRefreshTimer = null;
  }
}

function startRealtimeRefresh() {
  stopRealtimeRefresh();
  if (document.hidden) {
    return;
  }
  realtimeRefreshTimer = window.setInterval(() => {
    void runRealtimeRefresh();
  }, realtimeRefreshIntervalMs);
}

async function applyOverviewRange() {
  const startDate = $("#applications-range-start").value;
  const endDate = $("#applications-range-end").value;
  if (!startDate || !endDate) {
    return;
  }

  state.overviewRange = startDate <= endDate
    ? { startDate, endDate }
    : { startDate: endDate, endDate: startDate };
  persistOverviewRange(state.overviewRange);
  syncOverviewRangeInputs();
  state.applicationsLoaded = false;
  await ensureApplicationsData(true);
}

$("#save-config").addEventListener("click", async () => {
  await saveConfig();
  setUploadNote("パスを保存しました");
  await loadStatus();
});

$("#pick-oauth-json").addEventListener("click", () => {
  $("#oauth-json-file").click();
});

$("#open-settings").addEventListener("click", () => {
  const layer = $("#settings-layer");
  setSettingsOpen(!layer.classList.contains("open"));
});

$("#load-calendars").addEventListener("click", async () => {
  await loadCalendars();
});

$("#toggle-calendar-settings").addEventListener("click", () => {
  setCalendarSettingsExpanded(!state.calendarSettingsExpanded);
});

$("#toggle-fiscal-year-settings").addEventListener("click", () => {
  setFiscalYearSettingsExpanded(!state.fiscalYearSettingsExpanded);
});

$("#oauth-json-file").addEventListener("change", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || !target.files?.[0]) {
    return;
  }

  try {
    await uploadOAuthJson(target.files[0]);
    await loadStatus();
  } catch (error) {
    setUploadNote(error instanceof Error ? error.message : "JSON を保存できませんでした");
  } finally {
    target.value = "";
  }
});

["#coach-name", "#coach-code", "#coach-email"].forEach((selector) => {
  const input = $(selector);
  input.addEventListener("input", () => {
    scheduleConfigSave();
  });
  input.addEventListener("blur", async () => {
    if (configSaveTimer) {
      window.clearTimeout(configSaveTimer);
      configSaveTimer = null;
    }
    await saveConfig();
    setUploadNote("設定を保存しました");
  });
});

document.body.addEventListener("click", async (event) => {
  const loginButton = event.target.closest("#start-auth-google");
  if (loginButton) {
    await startGoogleLogin();
    return;
  }

  const logoutButton = event.target.closest("#logout-button");
  if (logoutButton) {
    await logout();
    return;
  }

  const disconnectButton = event.target.closest(".disconnect");
  if (disconnectButton) {
    await disconnectGoogle(disconnectButton.dataset.purpose, disconnectButton.dataset.accountId);
    return;
  }

  const connectButton = event.target.closest("[data-connect-purpose]");
  if (connectButton) {
    await connectGoogle(connectButton.dataset.connectPurpose);
    return;
  }

  const navButton = event.target.closest(".nav-button");
  if (navButton) {
    state.activeView = navButton.dataset.view;
    persistActiveView();
    renderAllViews();
    if (state.activeView === "students") {
      void ensureStudentsData();
    } else if (state.activeView === "applications") {
      void ensureApplicationsData();
    }
    return;
  }

  const studentButton = event.target.closest("[data-student-id]");
  if (studentButton) {
    state.selectedStudentId = studentButton.dataset.studentId;
    state.editingStudentNameId = null;
    renderStudents();
    return;
  }

  const openCreateStudentButton = event.target.closest("[data-open-create-student]");
  if (openCreateStudentButton) {
    state.selectedStudentId = NEW_STUDENT_ID;
    state.editingStudentNameId = null;
    renderStudents();
    return;
  }

  const editStudentNameButton = event.target.closest("[data-edit-student-name]");
  if (editStudentNameButton) {
    const studentId = editStudentNameButton.dataset.editStudentName;
    state.editingStudentNameId = state.editingStudentNameId === studentId ? null : studentId;
    renderStudents();
    if (state.editingStudentNameId === studentId) {
      requestAnimationFrame(() => {
        const input = document.querySelector(`[data-student-display-name="${CSS.escape(studentId)}"]`);
        if (input instanceof HTMLInputElement) {
          input.focus();
          input.select();
        }
      });
    }
    return;
  }

  const editCalendarTitleButton = event.target.closest("[data-edit-calendar-title]");
  if (editCalendarTitleButton) {
    const recordId = editCalendarTitleButton.dataset.editCalendarTitle;
    state.editingRecordTitleId = state.editingRecordTitleId === recordId ? null : recordId;
    renderAllViews();
    if (state.editingRecordTitleId === recordId) {
      requestAnimationFrame(() => {
        const input = document.querySelector(`[data-calendar-title="${CSS.escape(recordId)}"]`);
        if (input instanceof HTMLInputElement) {
          input.focus();
          input.select();
        }
      });
    }
    return;
  }

  const filterButton = event.target.closest("[data-application-filter]");
  if (filterButton) {
    state.applicationFilter = filterButton.dataset.applicationFilter;
    persistApplicationFilter();
    renderApplicationFilters();
    renderApplications();
    return;
  }

  const toggleButton = event.target.closest("[data-toggle-reconciliation]");
  if (toggleButton) {
    toggleReconciliation(toggleButton.dataset.toggleReconciliation);
    renderStudents();
    renderApplications();
    return;
  }

  const reconciliationRow = event.target.closest(".reconciliation-row");
  if (reconciliationRow && !reconciliationRow.classList.contains("expanded")) {
    const interactiveTarget = event.target.closest("button, input, select, textarea, a, label");
    if (!interactiveTarget) {
      const toggleId = reconciliationRow.querySelector("[data-toggle-reconciliation]")?.dataset?.toggleReconciliation;
      if (toggleId) {
        toggleReconciliation(toggleId);
        renderStudents();
        renderApplications();
        return;
      }
    }
  }

  const saveStudentCodeButton = event.target.closest("[data-save-student-code]");
  if (saveStudentCodeButton) {
    await saveStudentCodeForReconciliation(saveStudentCodeButton.dataset.saveStudentCode);
    return;
  }

  const saveManualStudentCodeButton = event.target.closest("[data-save-manual-student-code]");
  if (saveManualStudentCodeButton) {
    await saveStudentCodeForReconciliation(saveManualStudentCodeButton.dataset.saveManualStudentCode);
    return;
  }

  const ignoreButton = event.target.closest("[data-ignore-reconciliation]");
  if (ignoreButton) {
    await ignoreReconciliation(ignoreButton.dataset.ignoreReconciliation);
    return;
  }

  const restoreButton = event.target.closest("[data-restore-reconciliation]");
  if (restoreButton) {
    await restoreReconciliation(restoreButton.dataset.restoreReconciliation);
    return;
  }

  const createStudentButton = event.target.closest("[data-create-student]");
  if (createStudentButton) {
    const studentName = displayStudentName($("#new-student-name")?.value || "");
    const studentCode = $("#new-student-code")?.value?.trim() || "";
    const course = $("#new-student-course")?.value || "unknown";
    const teachingType = $("#new-student-teaching")?.value || "unknown";
    const weekdayValue = $("#new-student-weekday")?.value;
    const time = $("#new-student-time")?.value?.trim() || "";
    if (!studentName) {
      showToast("生徒名を入力してください。", "warning");
      return;
    }
    const studentKey = studentKeyFromName(studentName);
    const payload = {
      studentName,
      course,
      teachingType,
      weekday: weekdayValue === "" ? null : Number(weekdayValue),
      time: time || undefined,
      durationMinutes: 60,
      expectedKinds: deriveExpectedKindsFromProfile({ course, teachingType }),
      note: undefined,
      evidenceCount: 1,
    };
    try {
      await request(`/api/students/${encodeURIComponent(studentKey)}/profile`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (studentCode) {
        await request(`/api/students/${encodeURIComponent(studentKey)}/code`, {
          method: "POST",
          body: JSON.stringify({
            studentName,
            studentCode,
            evidenceCount: 1,
          }),
        });
      }
      const selectionId = selectedCalendarIds()[0] || "";
      if (selectionId && payload.weekday !== null && payload.time) {
        const fiscalRange = selectedFiscalYearRange();
        try {
          await request(`/api/students/${encodeURIComponent(studentKey)}/calendar-series`, {
            method: "POST",
            body: JSON.stringify({
              studentName,
              selectionId,
              weekday: payload.weekday,
              time: payload.time,
              until: fiscalRange.end,
            }),
          });
        } catch (calendarError) {
          noteError(calendarError);
          showToast("生徒は登録しましたが、繰り返し予定の作成に失敗しました。", "warning");
        }
      }
      showToast("生徒を登録しました。", "success");
      markSummaryDirty();
      state.studentsLoaded = false;
      await ensureStudentsData(true);
      state.selectedStudentId = studentKey;
      renderStudents();
      return;
    } catch (error) {
      noteError(error);
      markSummaryDirty();
      void refreshVisibleData();
      return;
    }
  }

  const closeCalendarDetailButton = event.target.closest("#close-calendar-detail");
  if (closeCalendarDetailButton) {
    clearCalendarDetail();
    renderCalendarDetail();
    return;
  }

  const invalidateButton = event.target.closest("[data-invalidate-submission]");
  if (invalidateButton) {
    if (window.confirm("この申請履歴を無効化しますか？")) {
      await invalidateSubmission(invalidateButton.dataset.invalidateSubmission);
    }
    return;
  }

  const applySuggestionButton = event.target.closest("[data-apply-calendar-suggestion]");
  if (applySuggestionButton) {
    await applyCalendarSuggestion(
      applySuggestionButton.dataset.applyCalendarSuggestion,
      applySuggestionButton.dataset.suggestionId,
    );
    return;
  }

  const deleteCalendarButton = event.target.closest("[data-delete-calendar]");
  if (deleteCalendarButton) {
    if (window.confirm("この予定を削除しますか？")) {
      await deleteCalendarForReconciliation(deleteCalendarButton.dataset.deleteCalendar);
    }
    return;
  }

  const autofillBundleButton = event.target.closest("[data-run-autofill-bundle]");
  if (autofillBundleButton) {
    await runAutofillForReconciliation(autofillBundleButton.dataset.runAutofillBundle);
    return;
  }

  const autofillButton = event.target.closest("[data-run-autofill]");
  if (autofillButton) {
    await runAutofillForReconciliation(autofillButton.dataset.runAutofill);
    return;
  }

  const autofillReasonButton = event.target.closest("[data-show-autofill-reason]");
  if (autofillReasonButton) {
    showAutofillBlockedReason(autofillReasonButton.dataset.showAutofillReason);
    return;
  }

});

document.body.addEventListener("change", async (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.closest("#settings-calendar-picker")) {
    persistSelectedCalendarIds(selectedCalendarIds());
    markSummaryDirty();
    clearCalendarDetail();
    await refreshVisibleData({ refetchCalendar: true });
    preloadSidebarData(true);
    return;
  }

  if (target instanceof HTMLInputElement && target.closest("#settings-fiscal-year-picker")) {
    const years = Array.from(document.querySelectorAll("#settings-fiscal-year-picker input:checked"))
      .map((input) => Number(input.value))
      .filter((value) => Number.isInteger(value))
      .sort((left, right) => right - left);
    state.selectedFiscalYears = years.length > 0 ? years : defaultFiscalYears();
    persistFiscalYears(state.selectedFiscalYears);
    renderFiscalYearPicker();
    clearCalendarDetail();
    state.studentsLoaded = false;
    await ensureStudentsData(true);
    if (state.activeView === "calendar") {
      requestCalendarRelayout(true);
    } else {
      renderAllViews();
    }
    return;
  }

  if (target instanceof HTMLInputElement && target.id === "student-search") {
    renderStudents();
    return;
  }

  if (target instanceof HTMLInputElement && (target.id === "applications-range-start" || target.id === "applications-range-end")) {
    await applyOverviewRange();
    return;
  }

  if ((target instanceof HTMLInputElement || target instanceof HTMLSelectElement) && (
    target.dataset.studentDisplayName
    || target.dataset.studentRoutineCourse
    || target.dataset.studentRoutineTeaching
    || target.dataset.studentRoutineWeekday
    || target.dataset.studentRoutineTime
  )) {
    const studentId = target.dataset.studentDisplayName || target.dataset.studentRoutineCourse || target.dataset.studentRoutineTeaching || target.dataset.studentRoutineWeekday || target.dataset.studentRoutineTime;
    scheduleStudentRoutineSave(studentId);
  }
});

document.body.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }
  if (target.dataset.calendarTitle) {
    scheduleCalendarTitleSave(target.dataset.calendarTitle);
    return;
  }
  if (
    target.dataset.studentDisplayName
    || target.dataset.studentRoutineTime
    || target.dataset.studentRoutineCourse
    || target.dataset.studentRoutineTeaching
  ) {
    const studentId = target.dataset.studentDisplayName || target.dataset.studentRoutineTime || target.dataset.studentRoutineCourse || target.dataset.studentRoutineTeaching;
    scheduleStudentRoutineSave(studentId);
  }
});

document.body.addEventListener("blur", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) {
    return;
  }
  if (target.dataset.calendarTitle) {
    if (calendarTitleSaveTimers.has(target.dataset.calendarTitle)) {
      window.clearTimeout(calendarTitleSaveTimers.get(target.dataset.calendarTitle));
      calendarTitleSaveTimers.delete(target.dataset.calendarTitle);
    }
    await saveCalendarTitleForReconciliation(target.dataset.calendarTitle);
    state.editingRecordTitleId = null;
    renderAllViews();
    return;
  }
  if (
    target.dataset.studentDisplayName
    || target.dataset.studentRoutineCourse
    || target.dataset.studentRoutineTeaching
    || target.dataset.studentRoutineWeekday
    || target.dataset.studentRoutineTime
  ) {
    const studentId = target.dataset.studentDisplayName || target.dataset.studentRoutineWeekday || target.dataset.studentRoutineTime || target.dataset.studentRoutineCourse || target.dataset.studentRoutineTeaching;
    if (studentRoutineSaveTimers.has(studentId)) {
      window.clearTimeout(studentRoutineSaveTimers.get(studentId));
      studentRoutineSaveTimers.delete(studentId);
    }
    await saveStudentRoutineProfile(studentId);
    state.editingStudentNameId = null;
    renderStudents();
  }
}, true);

window.addEventListener("resize", () => {
  if (state.calendar && state.activeView === "calendar") {
    requestAnimationFrame(() => {
      syncCalendarLayout();
      state.calendar.updateSize();
    });
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopRealtimeRefresh();
    return;
  }
  if (!state.me) {
    return;
  }
  void runRealtimeRefresh();
  startRealtimeRefresh();
});

state.overviewRange = loadPersistedOverviewRange();
state.selectedFiscalYears = loadPersistedFiscalYears();
state.calendarDetailWidth = loadPersistedCalendarDetailWidth();
restoreActiveView();
restoreApplicationFilter();
syncOverviewRangeInputs();
await loadCurrentUser();
state.authLoaded = true;
setCalendarSettingsExpanded(false);
setFiscalYearSettingsExpanded(false);
bindCalendarDivider();
bindCalendarResizeObserver();
void hasZenAutofillExtension();
renderFiscalYearPicker();
renderAllViews();
if (state.me) {
  await Promise.all([loadConfig(), loadStatus()]);
  await loadCalendars().catch(() => {
    state.students = [];
    state.applications = [];
    state.studentsLoaded = false;
    state.applicationsLoaded = false;
    syncSelectedStudent();
    renderAllViews();
    $("#settings-calendar-picker").innerHTML = "<p class='muted'>Calendar を接続してください。</p>";
    $("#calendar-selection-summary").textContent = "0件";
    renderFiscalYearPicker();
  });
  startRealtimeRefresh();
}
