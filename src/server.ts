import express, { type Request, type Response } from "express";
import { join } from "node:path";

import { DEFAULT_CONFIG, FORM_CATALOG, LOCAL_BASE_URL } from "./constants.js";
import { AppDatabase } from "./db.js";
import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  fetchCalendarSessions,
  fetchGmailSubmissions,
  fetchSheetRoster,
  listCalendars,
  loadSavedTokens,
} from "./google.js";
import { buildTasks, buildSyncSummary, describeAudit, enrichTask, openableTask } from "./taskService.js";
import type { AnswerValue, AppConfig, RosterEntry, TaskRecord, TaskStatus } from "./types.js";

const projectRoot = process.cwd();
const publicDir = join(projectRoot, "public");

const app = express();
const db = new AppDatabase();

app.use(express.json({ limit: "2mb" }));
app.use((request, response, next) => {
  response.header("Access-Control-Allow-Origin", "*");
  response.header("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  response.header("Access-Control-Allow-Headers", "Content-Type");
  if (request.method === "OPTIONS") {
    response.sendStatus(204);
    return;
  }
  next();
});

app.use(express.static(publicDir));

function respondError(response: Response, error: unknown, status = 500) {
  response.status(status).json({
    error: error instanceof Error ? error.message : "Unknown error",
  });
}

function mergeConfig(current: AppConfig, patch: Partial<AppConfig>): AppConfig {
  return {
    ...current,
    ...patch,
    coachProfile: {
      ...current.coachProfile,
      ...patch.coachProfile,
    },
    googleOAuth: {
      ...current.googleOAuth,
      ...patch.googleOAuth,
    },
    calendars: {
      ...current.calendars,
      ...patch.calendars,
    },
    gmail: {
      ...current.gmail,
      ...patch.gmail,
      queries: {
        ...current.gmail.queries,
        ...patch.gmail?.queries,
      },
    },
    sheets: {
      ...current.sheets,
      ...patch.sheets,
    },
  };
}

function parseTaskPatch(body: Record<string, unknown>): Record<string, AnswerValue> {
  const patch: Record<string, AnswerValue> = {};
  Object.entries(body).forEach(([key, value]) => {
    if (typeof value === "string" || Array.isArray(value)) {
      patch[key] = value as AnswerValue;
      return;
    }
    if (value && typeof value === "object") {
      const candidate = value as { date?: string; time?: string };
      patch[key] = {
        date: typeof candidate.date === "string" ? candidate.date : undefined,
        time: typeof candidate.time === "string" ? candidate.time : undefined,
      };
    }
  });
  return patch;
}

function buildRosterEntry(body: Record<string, unknown>, fallback: Partial<RosterEntry> = {}): RosterEntry {
  const now = new Date().toISOString();
  return {
    studentCode: String(body.studentCode ?? fallback.studentCode ?? "").trim(),
    studentName: String(body.studentName ?? fallback.studentName ?? "").trim(),
    aliases: Array.isArray(body.aliases)
      ? body.aliases.filter((value: unknown): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean)
      : fallback.aliases ?? [],
    calendarMatchPattern: String(body.calendarMatchPattern ?? fallback.calendarMatchPattern ?? "").trim(),
    handoffPolicy: String(body.handoffPolicy ?? fallback.handoffPolicy ?? "none") as RosterEntry["handoffPolicy"],
    defaultTaskType: String(body.defaultTaskType ?? fallback.defaultTaskType ?? "coaching") as RosterEntry["defaultTaskType"],
    manualOnly: Boolean(body.manualOnly ?? fallback.manualOnly ?? true),
    updatedAt: now,
  };
}

async function runSync() {
  const config = db.loadConfig();
  const existingRoster = db.listRoster();
  const roster = await fetchSheetRoster(config, existingRoster);
  db.upsertRosterEntries(roster);

  const sessions = await fetchCalendarSessions(config, roster);
  db.upsertCalendarSessions(sessions);

  const submissions = await fetchGmailSubmissions(config);
  db.upsertGmailSubmissions(submissions);

  const tasks = buildTasks(sessions, submissions, config, roster, db);
  db.upsertTasks(tasks);

  return buildSyncSummary(db, sessions.length, submissions.length, roster.length, tasks.length);
}

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/api/config", (_request, response) => {
  response.json({
    config: db.loadConfig(),
    defaults: DEFAULT_CONFIG,
  });
});

app.post("/api/config", (request, response) => {
  try {
    const current = db.loadConfig();
    const next = mergeConfig(current, request.body as Partial<AppConfig>);
    db.saveConfig(next);
    response.json({ config: next });
  } catch (error) {
    respondError(response, error, 400);
  }
});

app.get("/api/oauth/google/status", (_request, response) => {
  const config = db.loadConfig();
  const tokens = loadSavedTokens(config);
  response.json({
    connected: Boolean(tokens),
    callbackUrl: `${LOCAL_BASE_URL}/auth/google/callback`,
  });
});

app.post("/api/oauth/google/start", (request, response) => {
  try {
    const config = db.loadConfig();
    if (request.body?.clientCredentialsPath && typeof request.body.clientCredentialsPath === "string") {
      db.saveConfig(
        mergeConfig(config, {
          googleOAuth: {
            clientCredentialsPath: request.body.clientCredentialsPath,
          },
        }),
      );
    }

    response.json({
      authorizationUrl: buildGoogleAuthUrl(db.loadConfig()),
    });
  } catch (error) {
    respondError(response, error, 400);
  }
});

app.get("/auth/google/callback", async (request, response) => {
  try {
    const code = request.query.code;
    if (typeof code !== "string" || code.length === 0) {
      throw new Error("Authorization code is missing.");
    }
    await exchangeGoogleCode(db.loadConfig(), code);
    response.type("html").send(`
      <html>
        <body style="font-family: sans-serif; padding: 32px">
          <h1>Google connection complete</h1>
          <p>You can close this tab and return to the dashboard.</p>
        </body>
      </html>
    `);
  } catch (error) {
    respondError(response, error, 400);
  }
});

app.get("/api/google/calendars", async (_request, response) => {
  try {
    response.json({ calendars: await listCalendars(db.loadConfig()) });
  } catch (error) {
    respondError(response, error, 400);
  }
});

app.post("/api/sync/run", async (_request, response) => {
  try {
    const summary = await runSync();
    response.json({ summary });
  } catch (error) {
    respondError(response, error, 400);
  }
});

app.get("/api/calendar-sessions", (_request, response) => {
  response.json({
    sessions: db.listCalendarSessions(),
  });
});

app.get("/api/tasks", (request, response) => {
  const status = typeof request.query.status === "string" ? (request.query.status as TaskStatus) : undefined;
  response.json({
    tasks: db.listTasks(status),
  });
});

app.post("/api/tasks/:id/enrich", (request, response) => {
  const task = db.getTaskById(request.params.id);
  if (!task) {
    respondError(response, new Error("Task not found."), 404);
    return;
  }

  const patch = parseTaskPatch(request.body as Record<string, unknown>);
  const nextTask = enrichTask(task, patch);
  db.updateTask(nextTask.id, nextTask);
  response.json({ task: db.getTaskById(nextTask.id) });
});

app.post("/api/tasks/:id/open-form", (request, response) => {
  const task = db.getTaskById(request.params.id);
  if (!task) {
    respondError(response, new Error("Task not found."), 404);
    return;
  }

  if (!openableTask(task) && task.status !== "awaiting_user_submit" && task.status !== "error") {
    respondError(response, new Error("Task is not ready to open."), 400);
    return;
  }

  db.updateTask(task.id, {
    claimedAt: new Date().toISOString(),
    status: task.status === "error" ? "ready_to_open" : task.status,
    lastError: null,
  });

  response.json({
    task: db.getTaskById(task.id),
    launchUrl: `${FORM_CATALOG[task.formType].viewUrl}#gc-task=${encodeURIComponent(task.id)}`,
  });
});

app.post("/api/bridge/forms/claim-next", (request, response) => {
  const formKey = typeof request.body?.formKey === "string" ? request.body.formKey : null;
  const taskId = typeof request.body?.taskId === "string" ? request.body.taskId : null;
  if (!formKey) {
    respondError(response, new Error("formKey is required."), 400);
    return;
  }

  const candidate =
    taskId !== null
      ? db.getTaskById(taskId)
      : db
          .listTasks()
          .find((task) => task.formKey === formKey && ["ready_to_open", "error", "awaiting_user_submit"].includes(task.status));

  if (!candidate) {
    respondError(response, new Error("No pending task found for this form."), 404);
    return;
  }

  if (candidate.formKey !== formKey) {
    respondError(response, new Error("Task does not match current form."), 400);
    return;
  }

  db.updateTask(candidate.id, {
    claimedAt: new Date().toISOString(),
  });

  response.json({
    task: db.getTaskById(candidate.id),
    formUrl: FORM_CATALOG[candidate.formType].viewUrl,
  });
});

app.post("/api/bridge/forms/:id/autofill-complete", (request, response) => {
  const task = db.getTaskById(request.params.id);
  if (!task) {
    respondError(response, new Error("Task not found."), 404);
    return;
  }

  const missingQuestions = Array.isArray(request.body?.missingQuestions)
    ? request.body.missingQuestions.filter((value: unknown): value is string => typeof value === "string")
    : [];
  const error = typeof request.body?.error === "string" ? request.body.error : null;

  const patch: Partial<TaskRecord> =
    error || missingQuestions.length > 0
      ? {
          status: "error",
          lastError: error ?? `Visible required questions still missing: ${missingQuestions.join(", ")}`,
          updatedAt: new Date().toISOString(),
        }
      : {
          status: "awaiting_user_submit",
          lastError: null,
          updatedAt: new Date().toISOString(),
        };

  db.updateTask(task.id, patch);
  response.json({ task: db.getTaskById(task.id) });
});

app.get("/api/roster", (_request, response) => {
  response.json({ roster: db.listRoster() });
});

app.post("/api/roster", (request, response) => {
  const next = buildRosterEntry(request.body as Record<string, unknown>);
  if (!next.studentCode || !next.studentName) {
    respondError(response, new Error("studentCode and studentName are required."), 400);
    return;
  }

  db.upsertRosterEntries([next]);
  response.json({ roster: db.listRoster() });
});

app.put("/api/roster/:studentCode", (request, response) => {
  const existing = db.listRoster().find((entry) => entry.studentCode === request.params.studentCode);
  const next = buildRosterEntry(
    {
      ...(request.body as Record<string, unknown>),
      studentCode: request.params.studentCode,
    },
    existing ?? { studentCode: request.params.studentCode },
  );

  db.upsertRosterEntries([next]);
  response.json({ roster: db.listRoster() });
});

app.delete("/api/roster/:studentCode", (request, response) => {
  db.sqlite.prepare("DELETE FROM roster WHERE student_code = ?").run(request.params.studentCode);
  response.json({ roster: db.listRoster() });
});

app.get("/api/audit", (_request, response) => {
  response.json(describeAudit(db));
});

app.get("*", (_request, response) => {
  response.sendFile(join(publicDir, "index.html"));
});

app.listen(process.env.PORT ? Number(process.env.PORT) : 3131, () => {
  console.log(`gc-local-automation listening on ${LOCAL_BASE_URL}`);
});
