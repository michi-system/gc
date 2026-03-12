const VIEW_META = {
  summary: {
    eyebrow: "Overview",
    title: "見取りサマリー",
    subtitle: "未処理と処理済みをまとめて俯瞰し、いま詰まっている場所を先に見つけます。",
  },
  inbox: {
    eyebrow: "Inbox",
    title: "未処理",
    subtitle: "今日ではなく、今日までに処理すべきものを古い順に片付けます。",
  },
  table: {
    eyebrow: "Table",
    title: "一覧",
    subtitle: "全件をテーブルで検索し、状態や種別ごとに並べ替えて確認します。",
  },
  calendar: {
    eyebrow: "Calendar",
    title: "カレンダー",
    subtitle: "予定ベースで俯瞰し、補正候補や処理状況を月単位で確認します。",
  },
  settings: {
    eyebrow: "Settings",
    title: "設定",
    subtitle: "Google連携、コーチ情報、カレンダー選択、生徒台帳をここで編集します。",
  },
};

const state = {
  view: "summary",
  config: null,
  calendars: [],
  tasks: [],
  sessions: [],
  audit: null,
  roster: [],
  oauth: { connected: false, callbackUrl: "" },
  inboxFilter: "all",
  inboxOrder: "oldest",
  tableSearch: "",
  tableStatus: "all",
  tableType: "all",
  calendarMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  selectedDay: null,
  inspectorTaskId: null,
};

function $(selector) {
  return document.querySelector(selector);
}

function $$ (selector) {
  return Array.from(document.querySelectorAll(selector));
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
    throw new Error(payload.error || "Request failed");
  }
  return payload;
}

function statusTone(status) {
  if (status === "submitted_confirmed") return "success";
  if (status === "manual_review" || status === "pending_enrichment") return "warning";
  if (status === "error") return "danger";
  return "";
}

function statusLabel(status) {
  return {
    pending_enrichment: "不足あり",
    ready_to_open: "そのまま進められる",
    awaiting_user_submit: "送信待ち",
    submitted_confirmed: "送信済み",
    manual_review: "要確認",
    error: "エラー",
  }[status] || status;
}

function isProcessed(task) {
  return task.status === "submitted_confirmed";
}

function isPending(task) {
  return !isProcessed(task);
}

function taskCategory(task) {
  const haystack = `${task.title} ${JSON.stringify(task.payload.answers)}`;
  if (haystack.includes("過去問") || haystack.includes("小論文") || haystack.includes("ティーチング")) {
    return "teaching";
  }
  if (task.formType === "work_report_coaching") {
    return "coaching";
  }
  return "other";
}

function taskCategoryLabel(task) {
  return {
    coaching: "コーチング",
    teaching: "ティーチング",
    other: "その他",
  }[taskCategory(task)];
}

function taskDetailLabel(task) {
  const haystack = `${task.title} ${JSON.stringify(task.payload.answers)}`;
  if (haystack.includes("過去問")) return "過去問";
  if (haystack.includes("小論文")) return "小論文";
  if (taskCategory(task) === "teaching") return "通常";
  if (task.formType === "schedule_change") return "日程変更";
  if (task.formType === "handoff") return "引き継ぎ";
  return "通常";
}

function hasExtraThirty(task) {
  const detail = taskDetailLabel(task);
  return detail === "過去問" || detail === "小論文";
}

function sourceSession(task) {
  const ref = (task.sourceRefs || []).find((item) => item.kind === "calendar_event");
  if (!ref) {
    return null;
  }
  return state.sessions.find((session) => session.id === ref.value) || null;
}

function taskDate(task) {
  return task.sessionDate || sourceSession(task)?.sessionDate || task.createdAt?.slice(0, 10) || "";
}

function taskTime(task) {
  const session = sourceSession(task);
  if (!session?.startAt) {
    const dateTimeAnswer = task.payload.answers["変更後のコーチング時間を教えてください。"];
    if (dateTimeAnswer && typeof dateTimeAnswer === "object" && !Array.isArray(dateTimeAnswer) && dateTimeAnswer.time) {
      return dateTimeAnswer.time;
    }
    return "未設定";
  }
  return new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: state.config?.timezone || "Asia/Tokyo",
  }).format(new Date(session.startAt));
}

function formatDay(dateString) {
  if (!dateString) return "日付未設定";
  const date = new Date(`${dateString}T00:00:00`);
  return new Intl.DateTimeFormat("ja-JP", {
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(date);
}

function formatMonth(date) {
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "long",
  }).format(date);
}

function sortTasks(tasks, oldestFirst = true) {
  return [...tasks].sort((left, right) => {
    const leftKey = `${taskDate(left)} ${taskTime(left)}`;
    const rightKey = `${taskDate(right)} ${taskTime(right)}`;
    return oldestFirst ? leftKey.localeCompare(rightKey) : rightKey.localeCompare(leftKey);
  });
}

function groupedByDay(tasks) {
  const map = new Map();
  sortTasks(tasks, state.inboxOrder === "oldest").forEach((task) => {
    const key = taskDate(task) || "undated";
    const bucket = map.get(key) || [];
    bucket.push(task);
    map.set(key, bucket);
  });
  return Array.from(map.entries()).map(([date, entries]) => ({
    date,
    entries,
    pending: entries.filter(isPending).length,
    review: entries.filter((task) => task.status === "manual_review" || task.status === "pending_enrichment" || task.status === "error").length,
    waiting: entries.filter((task) => task.status === "awaiting_user_submit").length,
    extra: entries.filter(hasExtraThirty).length,
  }));
}

function summaryMetrics() {
  const unresolved = state.tasks.filter(isPending);
  const oldest = sortTasks(unresolved, true)[0];
  return [
    {
      label: "未処理合計",
      value: unresolved.length,
      detail: oldest ? `最古 ${formatDay(taskDate(oldest))}` : "未処理なし",
    },
    {
      label: "要確認",
      value: state.tasks.filter((task) => task.status === "manual_review" || task.status === "pending_enrichment").length,
      detail: "生徒未特定、タイトル補正、追加入力",
    },
    {
      label: "送信待ち",
      value: state.tasks.filter((task) => task.status === "awaiting_user_submit").length,
      detail: "フォーム入力済み。Gmail確認待ち。",
    },
    {
      label: "送信済み",
      value: state.tasks.filter((task) => task.status === "submitted_confirmed").length,
      detail: "処理済みとして一覧できます。",
    },
    {
      label: "追加30分想定",
      value: state.tasks.filter(hasExtraThirty).length,
      detail: "過去問 / 小論文のティーチング。",
    },
  ];
}

function friendlyIssue(task) {
  if (task.lastError) return task.lastError;
  if (task.status === "manual_review") return "タイトル補正か生徒特定の確認が必要";
  if (task.status === "pending_enrichment") return "不足項目の入力が必要";
  if (task.status === "awaiting_user_submit") return "送信は終わった想定。Gmail確認待ち";
  return "確認が必要";
}

function escaped(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function taskRowHtml(task) {
  return `
    <div class="day-task">
      <div class="day-task-top">
        <div>
          <strong>${escaped(task.studentName || task.title)}</strong>
          <div class="task-row-meta">
            <span class="mini-chip">${escaped(taskTime(task))}</span>
            <span class="mini-chip">${escaped(taskCategoryLabel(task))}</span>
            <span class="mini-chip">${escaped(taskDetailLabel(task))}</span>
            ${hasExtraThirty(task) ? `<span class="mini-chip">追加報告 +30分</span>` : ""}
          </div>
        </div>
        <div class="task-row-actions">
          <span class="state-pill ${statusTone(task.status)}">${escaped(statusLabel(task.status))}</span>
          <button class="secondary task-open" data-task-id="${escaped(task.id)}">詳細</button>
        </div>
      </div>
      <small>${escaped(friendlyIssue(task))}</small>
    </div>
  `;
}

function activateView(view) {
  state.view = view;
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  $$(".view").forEach((panel) => panel.classList.toggle("active", panel.id === `${view}-view`));
  $("#view-eyebrow").textContent = VIEW_META[view].eyebrow;
  $("#view-title").textContent = VIEW_META[view].title;
  $("#view-subtitle").textContent = VIEW_META[view].subtitle;
}

function renderSummary() {
  const metrics = summaryMetrics();
  const unresolved = state.tasks.filter(isPending);
  const grouped = groupedByDay(unresolved).slice(0, 6);
  const issues = sortTasks(
    state.tasks.filter((task) => ["manual_review", "pending_enrichment", "error", "awaiting_user_submit"].includes(task.status)),
    true,
  ).slice(0, 6);
  const recent = sortTasks(state.tasks.filter(isProcessed), false).slice(0, 6);
  const oldest = sortTasks(unresolved, true)[0];

  $("#summary-hero").innerHTML = `
    <p class="eyebrow">Backlog</p>
    <h3 class="hero-headline">${unresolved.length} 件の未処理</h3>
    <p class="panel-copy">今日ではなく、今日までに処理すべきものを古い順に片付ける前提で組んでいます。</p>
    <div class="hero-meta">
      <span class="hero-chip">最古 ${escaped(oldest ? formatDay(taskDate(oldest)) : "なし")}</span>
      <span class="hero-chip">処理済み ${state.tasks.filter(isProcessed).length} 件</span>
      <span class="hero-chip">要確認 ${issues.length} 件</span>
    </div>
    <div class="summary-actions">
      <button class="primary summary-switch" data-view="inbox">未処理を開く</button>
      <button class="secondary summary-switch" data-view="table">テーブル一覧</button>
      <button class="secondary summary-switch" data-view="settings">設定を見る</button>
    </div>
  `;

  $("#summary-health").innerHTML = `
    <div class="panel-header">
      <div>
        <p class="eyebrow">Health</p>
        <h3>運用ステータス</h3>
      </div>
      <span class="badge ${state.oauth.connected ? "success" : "warning"}">${state.oauth.connected ? "connected" : "not connected"}</span>
    </div>
    <div class="summary-list">
      <div class="summary-row">
        <div class="summary-row-header">
          <strong>Google接続</strong>
          <span class="state-pill ${state.oauth.connected ? "success" : "warning"}">${state.oauth.connected ? "利用可能" : "未接続"}</span>
        </div>
        <small>${escaped(state.oauth.callbackUrl || "Google連携後に callback を表示します。")}</small>
      </div>
      <div class="summary-row">
        <div class="summary-row-header">
          <strong>生徒台帳</strong>
          <span class="mini-chip">${state.roster.length} 名</span>
        </div>
        <small>完全手動管理。設定画面でいつでも追加・編集できます。</small>
      </div>
      <div class="summary-row">
        <div class="summary-row-header">
          <strong>対象カレンダー</strong>
          <span class="mini-chip">${state.config?.calendars?.selectedCalendarIds?.length || 0} 件</span>
        </div>
        <small>カレンダーは名前で選び、ID は表に出しません。</small>
      </div>
    </div>
  `;

  $("#summary-metrics").innerHTML = metrics
    .map(
      (metric) => `
        <article class="metric-card">
          <span class="metric-label">${escaped(metric.label)}</span>
          <strong class="metric-value">${escaped(metric.value)}</strong>
          <div class="metric-detail">${escaped(metric.detail)}</div>
        </article>
      `,
    )
    .join("");

  $("#summary-backlog").innerHTML = `
    <div class="panel-header">
      <div>
        <p class="eyebrow">Backlog by day</p>
        <h3>古い未処理</h3>
      </div>
    </div>
    <div class="summary-list">
      ${
        grouped.length === 0
          ? `<div class="empty-state">未処理はありません。</div>`
          : grouped
              .map(
                (group) => `
                  <div class="summary-row">
                    <div class="summary-row-header">
                      <strong>${escaped(formatDay(group.date))}</strong>
                      <span class="mini-chip">${group.entries.length} 件</span>
                    </div>
                    <small>要確認 ${group.review} 件 / 送信待ち ${group.waiting} 件 / +30分 ${group.extra} 件</small>
                  </div>
                `,
              )
              .join("")
      }
    </div>
  `;

  $("#summary-issues").innerHTML = `
    <div class="panel-header">
      <div>
        <p class="eyebrow">Attention</p>
        <h3>要確認</h3>
      </div>
    </div>
    <div class="issue-list">
      ${
        issues.length === 0
          ? `<div class="empty-state">現在、緊急の確認事項はありません。</div>`
          : issues
              .map(
                (task) => `
                  <div class="issue-row">
                    <div class="summary-row-header">
                      <strong>${escaped(task.studentName || task.title)}</strong>
                      <span class="state-pill ${statusTone(task.status)}">${escaped(statusLabel(task.status))}</span>
                    </div>
                    <small>${escaped(friendlyIssue(task))}</small>
                    <button class="secondary task-open" data-task-id="${escaped(task.id)}">詳細を見る</button>
                  </div>
                `,
              )
              .join("")
      }
    </div>
  `;

  $("#summary-recent").innerHTML = `
    <div class="panel-header">
      <div>
        <p class="eyebrow">Recent</p>
        <h3>最近の処理結果</h3>
      </div>
    </div>
    <div class="recent-list">
      ${
        recent.length === 0
          ? `<div class="empty-state">まだ処理済みデータがありません。</div>`
          : recent
              .map(
                (task) => `
                  <div class="recent-row">
                    <div class="recent-row-top">
                      <strong>${escaped(task.studentName || task.title)}</strong>
                      <span class="state-pill success">送信済み</span>
                    </div>
                    <small>${escaped(formatDay(taskDate(task)))} / ${escaped(taskCategoryLabel(task))} / ${escaped(taskDetailLabel(task))}</small>
                  </div>
                `,
              )
              .join("")
      }
    </div>
  `;
}

function filteredInboxTasks() {
  return state.tasks.filter((task) => {
    if (!isPending(task)) return false;
    if (state.inboxFilter === "all") return true;
    if (state.inboxFilter === "review") return ["manual_review", "pending_enrichment", "error"].includes(task.status);
    if (state.inboxFilter === "actionable") return task.status === "ready_to_open";
    if (state.inboxFilter === "waiting") return task.status === "awaiting_user_submit";
    if (state.inboxFilter === "error") return task.status === "error";
    return true;
  });
}

function renderInbox() {
  const groups = groupedByDay(filteredInboxTasks());
  $("#inbox-groups").innerHTML =
    groups.length === 0
      ? `<article class="day-card"><div class="empty-state">条件に合う未処理はありません。</div></article>`
      : groups
          .map(
            (group) => `
              <article class="day-card">
                <div class="day-card-header">
                  <div>
                    <p class="eyebrow">Day group</p>
                    <strong>${escaped(formatDay(group.date))}</strong>
                  </div>
                  <div class="day-card-meta">
                    <span class="mini-chip">${group.entries.length} 件</span>
                    <span class="mini-chip">要確認 ${group.review}</span>
                    <span class="mini-chip">送信待ち ${group.waiting}</span>
                    ${group.extra > 0 ? `<span class="mini-chip">+30分 ${group.extra}</span>` : ""}
                  </div>
                </div>
                ${group.entries.map(taskRowHtml).join("")}
              </article>
            `,
          )
          .join("");
}

function filteredTableTasks() {
  const query = state.tableSearch.trim().toLowerCase();
  return sortTasks(state.tasks, true).filter((task) => {
    if (state.tableStatus !== "all" && task.status !== state.tableStatus) return false;
    if (state.tableType !== "all" && taskCategory(task) !== state.tableType) return false;
    if (!query) return true;
    const haystack = [
      task.title,
      task.studentName,
      task.studentCode,
      taskCategoryLabel(task),
      taskDetailLabel(task),
      taskDate(task),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });
}

function renderTable() {
  const tasks = filteredTableTasks();
  $("#table-body").innerHTML =
    tasks.length === 0
      ? `<tr><td colspan="9"><div class="empty-state">条件に合うデータがありません。</div></td></tr>`
      : tasks
          .map(
            (task) => `
              <tr data-task-id="${escaped(task.id)}">
                <td>${escaped(taskDate(task) ? formatDay(taskDate(task)) : "日付未設定")}</td>
                <td>${escaped(taskTime(task))}</td>
                <td>
                  <strong>${escaped(task.studentName || "未特定")}</strong>
                  <div class="muted">${escaped(task.studentCode || "")}</div>
                </td>
                <td>${escaped(taskCategoryLabel(task))}</td>
                <td>${escaped(taskDetailLabel(task))}</td>
                <td>${hasExtraThirty(task) ? "＋30分" : "なし"}</td>
                <td><span class="state-pill ${statusTone(task.status)}">${escaped(statusLabel(task.status))}</span></td>
                <td>${task.status === "submitted_confirmed" ? "確認済み" : task.status === "awaiting_user_submit" ? "未確認" : "-"}</td>
                <td>${escaped(task.status === "manual_review" ? "要補正" : task.status === "error" ? "要確認" : "正常")}</td>
              </tr>
            `,
          )
          .join("");
}

function monthTasks(date) {
  const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  return state.tasks.filter((task) => taskDate(task).startsWith(monthKey));
}

function calendarCounts(tasks) {
  return {
    pending: tasks.filter((task) => ["pending_enrichment", "ready_to_open"].includes(task.status)).length,
    review: tasks.filter((task) => ["manual_review", "error"].includes(task.status)).length,
    done: tasks.filter((task) => task.status === "submitted_confirmed").length,
  };
}

function renderCalendar() {
  const month = state.calendarMonth;
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const first = new Date(year, monthIndex, 1);
  const startOffset = (first.getDay() + 6) % 7;
  const start = new Date(year, monthIndex, 1 - startOffset);
  const cells = [];

  for (let index = 0; index < 42; index += 1) {
    const cellDate = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
    const iso = `${cellDate.getFullYear()}-${String(cellDate.getMonth() + 1).padStart(2, "0")}-${String(cellDate.getDate()).padStart(2, "0")}`;
    const tasks = state.tasks.filter((task) => taskDate(task) === iso);
    const counts = calendarCounts(tasks);
    cells.push({ date: cellDate, iso, tasks, counts, currentMonth: cellDate.getMonth() === monthIndex });
  }

  $("#calendar-month-label").textContent = formatMonth(month);
  $("#calendar-grid").innerHTML = cells
    .map(
      (cell) => `
        <button class="calendar-cell ${cell.currentMonth ? "" : "outside"} ${state.selectedDay === cell.iso ? "selected" : ""}" data-day="${cell.iso}">
          <div class="calendar-cell-header">
            <strong>${cell.date.getDate()}</strong>
            <small>${cell.tasks.length || ""}</small>
          </div>
          <div class="calendar-dot-row">
            ${cell.counts.pending > 0 ? `<span class="calendar-dot pending" title="未処理"></span>` : ""}
            ${cell.counts.review > 0 ? `<span class="calendar-dot review" title="要確認"></span>` : ""}
            ${cell.counts.done > 0 ? `<span class="calendar-dot done" title="送信済み"></span>` : ""}
          </div>
        </button>
      `,
    )
    .join("");

  const selected = state.selectedDay || cells.find((cell) => cell.tasks.length > 0 && cell.currentMonth)?.iso || cells.find((cell) => cell.currentMonth)?.iso;
  state.selectedDay = selected;
  const selectedTasks = sortTasks(state.tasks.filter((task) => taskDate(task) === selected), true);
  $("#calendar-day-panel").innerHTML = `
    <div class="panel-header">
      <div>
        <p class="eyebrow">Selected day</p>
        <h3>${escaped(formatDay(selected))}</h3>
      </div>
      <span class="mini-chip">${selectedTasks.length} 件</span>
    </div>
    <div class="calendar-day-list">
      ${
        selectedTasks.length === 0
          ? `<div class="empty-state">この日に紐づく task はありません。</div>`
          : selectedTasks.map(taskRowHtml).join("")
      }
    </div>
  `;
}

function renderCalendars() {
  const root = $("#calendar-options");
  root.innerHTML = "";
  if (state.calendars.length === 0) {
    root.innerHTML = `<div class="empty-state">Google接続後にカレンダー一覧を読み込みます。</div>`;
    return;
  }

  state.calendars.forEach((calendar) => {
    const card = document.createElement("label");
    card.className = "selection-card";
    card.innerHTML = `
      <input type="checkbox" value="${escaped(calendar.id)}" ${state.config.calendars.selectedCalendarIds.includes(calendar.id) ? "checked" : ""} />
      <div>
        <strong>${escaped(calendar.summary)}</strong>
        <div class="muted">${calendar.primary ? "primary calendar" : "calendar"}</div>
      </div>
    `;
    root.appendChild(card);
  });
}

function renderRoster() {
  const root = $("#student-list");
  root.innerHTML =
    state.roster.length === 0
      ? `<div class="empty-state">まだ生徒が登録されていません。上のフォームから追加できます。</div>`
      : state.roster
          .map(
            (entry) => `
              <article class="student-card" data-student-code="${escaped(entry.studentCode)}">
                <div class="summary-row-header">
                  <div>
                    <strong>${escaped(entry.studentName)}</strong>
                    <div class="muted">${escaped(entry.studentCode)}</div>
                  </div>
                  <span class="mini-chip">${escaped(entry.defaultTaskType)}</span>
                </div>
                <div class="student-card-grid">
                  <label class="field">
                    <span>生徒名</span>
                    <input data-field="studentName" value="${escaped(entry.studentName)}" />
                  </label>
                  <label class="field">
                    <span>生徒コード</span>
                    <input data-field="studentCode" value="${escaped(entry.studentCode)}" disabled />
                  </label>
                  <label class="field">
                    <span>別名</span>
                    <input data-field="aliases" value="${escaped(entry.aliases.join(", "))}" />
                  </label>
                  <label class="field">
                    <span>引き継ぎ</span>
                    <select data-field="handoffPolicy">
                      ${["none", "advance_premium", "coach_change", "substitute"]
                        .map((value) => `<option value="${value}" ${entry.handoffPolicy === value ? "selected" : ""}>${value}</option>`)
                        .join("")}
                    </select>
                  </label>
                  <label class="field">
                    <span>既定種別</span>
                    <select data-field="defaultTaskType">
                      ${["coaching", "teaching", "other"]
                        .map((value) => `<option value="${value}" ${entry.defaultTaskType === value ? "selected" : ""}>${value}</option>`)
                        .join("")}
                    </select>
                  </label>
                  <label class="field">
                    <span>補助マッチ文字列</span>
                    <input data-field="calendarMatchPattern" value="${escaped(entry.calendarMatchPattern || "")}" />
                  </label>
                </div>
                <div class="student-actions">
                  <button class="secondary roster-save">保存</button>
                  <button class="ghost roster-delete">削除</button>
                </div>
              </article>
            `,
          )
          .join("");
}

function renderSettings() {
  if (!state.config) {
    return;
  }

  $("#coach-name").value = state.config.coachProfile.coachName;
  $("#coach-code").value = state.config.coachProfile.coachCode;
  $("#coach-email").value = state.config.coachProfile.email;
  $("#credentials-path").value = state.config.googleOAuth.clientCredentialsPath;
  $("#timezone").value = state.config.timezone;
  $("#sync-window-days").value = state.config.syncWindowDays;
  $("#query-work-report").value = state.config.gmail.queries.work_report;
  $("#query-schedule-change").value = state.config.gmail.queries.schedule_change;
  $("#query-handoff").value = state.config.gmail.queries.handoff;

  $("#oauth-status").textContent = state.oauth.connected ? "connected" : "not connected";
  $("#oauth-status").className = `badge ${state.oauth.connected ? "success" : "warning"}`;

  renderCalendars();
  renderRoster();
}

function renderAll() {
  if (!state.config) return;

  activateView(state.view);
  $("#connection-chip").textContent = state.oauth.connected
    ? `Google接続済み ${state.config.coachProfile.email || ""}`.trim()
    : "Google未接続";
  $("#connection-chip").classList.toggle("connected", state.oauth.connected);
  renderSummary();
  renderInbox();
  renderTable();
  renderCalendar();
  renderSettings();
  renderInspector();
}

function renderFieldEditor(task, field) {
  const currentValue = task.payload.answers[field.title];
  if (field.kind === "textarea") {
    return `<textarea data-field="${escaped(field.title)}">${typeof currentValue === "string" ? escaped(currentValue) : ""}</textarea>`;
  }

  if (field.kind === "dropdown" || field.kind === "radio") {
    return `
      <select data-field="${escaped(field.title)}">
        <option value=""></option>
        ${(field.options || [])
          .map((option) => `<option value="${escaped(option)}" ${currentValue === option ? "selected" : ""}>${escaped(option)}</option>`)
          .join("")}
      </select>
    `;
  }

  if (field.kind === "checkbox") {
    const values = Array.isArray(currentValue) ? currentValue : [];
    return `
      <div class="summary-list">
        ${(field.options || [])
          .map(
            (option) => `
              <label class="selection-card">
                <input type="checkbox" data-field="${escaped(field.title)}" value="${escaped(option)}" ${values.includes(option) ? "checked" : ""} />
                <div>${escaped(option)}</div>
              </label>
            `,
          )
          .join("")}
      </div>
    `;
  }

  if (field.kind === "dateTime") {
    const value = currentValue && typeof currentValue === "object" && !Array.isArray(currentValue) ? currentValue : {};
    return `
      <div class="field-grid">
        <label class="field">
          <span>日付</span>
          <input type="date" data-field="${escaped(field.title)}" data-part="date" value="${escaped(value.date || "")}" />
        </label>
        <label class="field">
          <span>時刻</span>
          <input type="time" data-field="${escaped(field.title)}" data-part="time" value="${escaped(value.time || "")}" />
        </label>
      </div>
    `;
  }

  return `<input data-field="${escaped(field.title)}" value="${typeof currentValue === "string" ? escaped(currentValue) : ""}" />`;
}

function collectTaskPatch(container) {
  const patch = {};
  container.querySelectorAll("[data-field]").forEach((node) => {
    const title = node.dataset.field;
    if (!title) return;
    if (node.type === "checkbox") {
      patch[title] = Array.from(container.querySelectorAll(`input[data-field="${CSS.escape(title)}"]:checked`)).map((item) => item.value);
      return;
    }
    if (node.dataset.part) {
      patch[title] = patch[title] || {};
      patch[title][node.dataset.part] = node.value;
      return;
    }
    patch[title] = node.value;
  });
  return patch;
}

function renderInspector() {
  const task = state.tasks.find((entry) => entry.id === state.inspectorTaskId);
  const inspector = $("#task-inspector");
  const overlay = $("#inspector-overlay");
  inspector.classList.toggle("open", Boolean(task));
  overlay.classList.toggle("open", Boolean(task));

  if (!task) {
    $("#inspector-body").innerHTML = "";
    return;
  }

  $("#inspector-title").textContent = task.studentName || task.title;
  $("#inspector-body").innerHTML = `
    <section class="inspector-section">
      <div class="meta-pair"><strong>日付</strong><span>${escaped(formatDay(taskDate(task)))}</span></div>
      <div class="meta-pair"><strong>時刻</strong><span>${escaped(taskTime(task))}</span></div>
      <div class="meta-pair"><strong>状態</strong><span class="state-pill ${statusTone(task.status)}">${escaped(statusLabel(task.status))}</span></div>
      <div class="meta-pair"><strong>種別</strong><span>${escaped(taskCategoryLabel(task))} / ${escaped(taskDetailLabel(task))}</span></div>
      ${
        hasExtraThirty(task)
          ? `<div class="helper-line"><span class="helper-dot"></span><span>過去問 / 小論文のため、追加報告 +30分 を前提に扱います。</span></div>`
          : ""
      }
    </section>

    ${
      task.payload.reviewHints.length > 0
        ? `
          <section class="inspector-section">
            <strong>レビュー用メモ</strong>
            ${task.payload.reviewHints.map((hint) => `<small>${escaped(hint)}</small>`).join("")}
          </section>
        `
        : ""
    }

    ${
      task.lastError
        ? `
          <section class="inspector-section">
            <strong>エラー / 注意</strong>
            <small>${escaped(task.lastError)}</small>
          </section>
        `
        : ""
    }

    <section class="inspector-section">
      <strong>不足項目</strong>
      ${
        task.missingFields.length === 0
          ? `<small>不足項目はありません。このままフォームを開けます。</small>`
          : task.missingFields
              .map((title) => {
                const field = task.payload.fieldSpecs.find((entry) => entry.title === title);
                if (!field) return "";
                return `
                  <label class="field">
                    <span>${escaped(title)}</span>
                    ${renderFieldEditor(task, field)}
                  </label>
                `;
              })
              .join("")
      }
    </section>

    <section class="inspector-section">
      <strong>根拠</strong>
      ${(task.sourceRefs || []).map((ref) => `<small>${escaped(ref.label)}: ${escaped(ref.value)}</small>`).join("")}
    </section>
  `;

  $("#inspector-open").disabled = task.status === "manual_review";
}

async function loadConfig() {
  const { config } = await request("/api/config");
  state.config = config;
}

async function loadOauthStatus() {
  const payload = await request("/api/oauth/google/status");
  state.oauth = payload;
}

async function loadCalendars() {
  if (!state.oauth.connected) {
    state.calendars = [];
    return;
  }
  try {
    const { calendars } = await request("/api/google/calendars");
    state.calendars = calendars;
  } catch {
    state.calendars = [];
  }
}

async function loadTasks() {
  const { tasks } = await request("/api/tasks");
  state.tasks = tasks;
}

async function loadSessions() {
  const { sessions } = await request("/api/calendar-sessions");
  state.sessions = sessions;
}

async function loadAudit() {
  state.audit = await request("/api/audit");
}

async function loadRoster() {
  const { roster } = await request("/api/roster");
  state.roster = roster;
}

function collectConfigPatch() {
  return {
    googleOAuth: {
      clientCredentialsPath: $("#credentials-path").value.trim(),
    },
    coachProfile: {
      coachName: $("#coach-name").value.trim(),
      coachCode: $("#coach-code").value.trim(),
      email: $("#coach-email").value.trim(),
    },
    timezone: $("#timezone").value.trim(),
    syncWindowDays: Number($("#sync-window-days").value || 21),
    calendars: {
      selectedCalendarIds: Array.from(document.querySelectorAll("#calendar-options input:checked")).map((input) => input.value),
    },
    gmail: {
      queries: {
        work_report: $("#query-work-report").value.trim(),
        schedule_change: $("#query-schedule-change").value.trim(),
        handoff: $("#query-handoff").value.trim(),
      },
    },
  };
}

async function saveConfig() {
  await request("/api/config", {
    method: "POST",
    body: JSON.stringify(collectConfigPatch()),
  });
  await initialize();
}

async function connectGoogle() {
  const { authorizationUrl } = await request("/api/oauth/google/start", {
    method: "POST",
    body: JSON.stringify({
      clientCredentialsPath: $("#credentials-path").value.trim(),
    }),
  });
  window.open(authorizationUrl, "_blank", "noopener");
}

async function runSync() {
  await saveConfig();
  await request("/api/sync/run", { method: "POST" });
  await initialize();
}

async function saveRosterCard(card) {
  const code = card.dataset.studentCode;
  if (!code) return;
  const aliases = card.querySelector('[data-field="aliases"]').value
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  await request(`/api/roster/${encodeURIComponent(code)}`, {
    method: "PUT",
    body: JSON.stringify({
      studentName: card.querySelector('[data-field="studentName"]').value,
      aliases,
      handoffPolicy: card.querySelector('[data-field="handoffPolicy"]').value,
      defaultTaskType: card.querySelector('[data-field="defaultTaskType"]').value,
      calendarMatchPattern: card.querySelector('[data-field="calendarMatchPattern"]').value,
      manualOnly: true,
    }),
  });
  await loadRoster();
  renderAll();
}

async function addStudent(event) {
  event.preventDefault();
  const aliases = $("#student-aliases-input")
    .value.split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  await request("/api/roster", {
    method: "POST",
    body: JSON.stringify({
      studentName: $("#student-name-input").value.trim(),
      studentCode: $("#student-code-input").value.trim(),
      aliases,
      handoffPolicy: $("#student-handoff-input").value,
      defaultTaskType: $("#student-type-input").value,
      manualOnly: true,
    }),
  });

  event.target.reset();
  await loadRoster();
  renderAll();
}

async function deleteStudent(code) {
  await request(`/api/roster/${encodeURIComponent(code)}`, {
    method: "DELETE",
  });
  await loadRoster();
  renderAll();
}

async function saveInspector() {
  const task = state.tasks.find((entry) => entry.id === state.inspectorTaskId);
  if (!task) return;
  await request(`/api/tasks/${encodeURIComponent(task.id)}/enrich`, {
    method: "POST",
    body: JSON.stringify(collectTaskPatch($("#inspector-body"))),
  });
  await loadTasks();
  await loadAudit();
  renderAll();
}

async function openFormFromInspector() {
  const task = state.tasks.find((entry) => entry.id === state.inspectorTaskId);
  if (!task) return;
  const { launchUrl } = await request(`/api/tasks/${encodeURIComponent(task.id)}/open-form`, {
    method: "POST",
  });
  window.open(launchUrl, "_blank", "noopener");
  await loadTasks();
  await loadAudit();
  renderAll();
}

function bindEvents() {
  $$(".nav-item").forEach((button) => {
    button.addEventListener("click", () => {
      state.view = button.dataset.view;
      renderAll();
    });
  });

  $("#connect-google").addEventListener("click", connectGoogle);
  $("#settings-connect-google").addEventListener("click", connectGoogle);
  $("#run-sync").addEventListener("click", runSync);
  $("#save-config").addEventListener("click", saveConfig);
  $("#student-form").addEventListener("submit", addStudent);

  $("#inbox-filter").addEventListener("change", (event) => {
    state.inboxFilter = event.target.value;
    renderInbox();
  });
  $("#inbox-order").addEventListener("change", (event) => {
    state.inboxOrder = event.target.value;
    renderInbox();
  });
  $("#table-search").addEventListener("input", (event) => {
    state.tableSearch = event.target.value;
    renderTable();
  });
  $("#table-status").addEventListener("change", (event) => {
    state.tableStatus = event.target.value;
    renderTable();
  });
  $("#table-type").addEventListener("change", (event) => {
    state.tableType = event.target.value;
    renderTable();
  });

  $("#calendar-prev").addEventListener("click", () => {
    state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() - 1, 1);
    renderCalendar();
  });
  $("#calendar-next").addEventListener("click", () => {
    state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() + 1, 1);
    renderCalendar();
  });

  document.body.addEventListener("click", async (event) => {
    const openTaskButton = event.target.closest(".task-open");
    if (openTaskButton) {
      state.inspectorTaskId = openTaskButton.dataset.taskId;
      renderInspector();
      return;
    }

    const summarySwitch = event.target.closest(".summary-switch");
    if (summarySwitch) {
      state.view = summarySwitch.dataset.view;
      renderAll();
      return;
    }

    const tableRow = event.target.closest("#table-body tr[data-task-id]");
    if (tableRow) {
      state.inspectorTaskId = tableRow.dataset.taskId;
      renderInspector();
      return;
    }

    const calendarCell = event.target.closest(".calendar-cell");
    if (calendarCell) {
      state.selectedDay = calendarCell.dataset.day;
      renderCalendar();
      return;
    }

    const rosterSave = event.target.closest(".roster-save");
    if (rosterSave) {
      await saveRosterCard(rosterSave.closest(".student-card"));
      return;
    }

    const rosterDelete = event.target.closest(".roster-delete");
    if (rosterDelete) {
      const card = rosterDelete.closest(".student-card");
      await deleteStudent(card.dataset.studentCode);
    }
  });

  $("#inspector-close").addEventListener("click", () => {
    state.inspectorTaskId = null;
    renderInspector();
  });
  $("#inspector-overlay").addEventListener("click", () => {
    state.inspectorTaskId = null;
    renderInspector();
  });
  $("#inspector-save").addEventListener("click", saveInspector);
  $("#inspector-open").addEventListener("click", openFormFromInspector);
}

async function initialize() {
  await loadConfig();
  await loadOauthStatus();
  await Promise.all([loadCalendars(), loadTasks(), loadSessions(), loadAudit(), loadRoster()]);
  renderAll();
}

bindEvents();
initialize().catch((error) => {
  alert(error.message);
});
