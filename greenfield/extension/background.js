const pendingTasks = new Map();

function normalize(value) {
  return String(value || "").trim();
}

function formIdForTask(task) {
  if (task?.formKey === "work_report") return "1FAIpQLScX1kcDYuuEp3rNVGqIWVYQT4r5nTLXiFmKm4Dpfar7BVMSgQ";
  if (task?.formKey === "schedule_change") return "1FAIpQLSdCborRTdo0u9Oicusv2NHoP1lwR8uhqZCShLl2uzFaxmzxeQ";
  if (task?.formKey === "handoff") return "1FAIpQLSek3Acb1pm-vYtr8vbr7fVdLGKq615X8wv7SyClSUVeLNi4mw";
  return "";
}

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "GC_AUTOFILL_RUN" && message.task) {
    const task = message.task;
    pendingTasks.set(task.id, task);
    return browser.tabs.create({
      url: task.launchUrl,
      active: true,
    }).then(() => ({ ok: true }));
  }

  if (message?.type === "GC_AUTOFILL_CLAIM") {
    const taskId = normalize(message.taskId);
    const formKey = normalize(message.formKey);
    const task = taskId
      ? pendingTasks.get(taskId)
      : Array.from(pendingTasks.values()).find((candidate) => candidate.formKey === formKey);
    return Promise.resolve(task ? { task } : { task: null });
  }

  if (message?.type === "GC_AUTOFILL_RELEASE") {
    const taskId = normalize(message.taskId);
    const keep = Boolean(message.keep);
    if (taskId && !keep) {
      pendingTasks.delete(taskId);
    }
    return Promise.resolve({ ok: true });
  }

  if (message?.type === "GC_AUTOFILL_PEEK") {
    const tasks = Array.from(pendingTasks.values()).map((task) => ({
      id: task.id,
      formKey: task.formKey,
      formId: formIdForTask(task),
    }));
    return Promise.resolve({ tasks });
  }

  return undefined;
});
