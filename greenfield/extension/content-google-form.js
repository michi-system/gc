(function () {
  "use strict";

  const LOCAL_BASE_URL = "http://127.0.0.1:3141";
  const PENDING_SUBMIT_TASK_STORAGE_KEY = "gc-greenfield:pending-submit-task";
  const runtime = { started: false, task: null, notified: false };

  function normalize(value) {
    return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").replace(/\s+\*$/, "").trim();
  }
  function questionTitleVariants(value) {
    const normalized = normalize(value);
    const variants = new Set([normalized]);
    const firstLine = normalized.split("※")[0]?.trim();
    if (firstLine) variants.add(firstLine);
    const firstSentence = normalized.split("\n")[0]?.trim();
    if (firstSentence) variants.add(firstSentence);
    return Array.from(variants).filter(Boolean);
  }
  function questionTitleMatches(actual, expected) {
    const actualVariants = questionTitleVariants(actual);
    const expectedVariants = questionTitleVariants(expected);
    return actualVariants.some((actualValue) =>
      expectedVariants.some((expectedValue) =>
        actualValue === expectedValue || actualValue.startsWith(expectedValue) || expectedValue.startsWith(actualValue),
      ),
    );
  }
  function sleep(ms) { return new Promise((resolve) => window.setTimeout(resolve, ms)); }
  function isVisible(node) {
    if (!node) return false;
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function taskIdFromHash() {
    const raw = window.location.hash.replace(/^#/, "");
    if (!raw) return null;
    return new URLSearchParams(raw).get("gc-task");
  }
  function currentFormKey() {
    const href = window.location.href;
    if (href.includes("1FAIpQLScX1kcDYuuEp3rNVGqIWVYQT4r5nTLXiFmKm4Dpfar7BVMSgQ")) return "work_report";
    if (href.includes("1FAIpQLSdCborRTdo0u9Oicusv2NHoP1lwR8uhqZCShLl2uzFaxmzxeQ")) return "schedule_change";
    if (href.includes("1FAIpQLSek3Acb1pm-vYtr8vbr7fVdLGKq615X8wv7SyClSUVeLNi4mw")) return "handoff";
    return null;
  }
  function isConfirmationScreen() {
    const text = normalize(document.body.textContent);
    return text.includes("回答を記録しました") || text.includes("回答を受け付けました") || text.includes("your response has been recorded");
  }
  function loadPendingSubmitTask() {
    try {
      const raw = window.sessionStorage.getItem(PENDING_SUBMIT_TASK_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  function savePendingSubmitTask(taskId, formKey) {
    window.sessionStorage.setItem(PENDING_SUBMIT_TASK_STORAGE_KEY, JSON.stringify({ taskId, formKey }));
  }
  function clearPendingSubmitTask() {
    window.sessionStorage.removeItem(PENDING_SUBMIT_TASK_STORAGE_KEY);
  }
  async function request(path, options) {
    const response = await fetch(`${LOCAL_BASE_URL}${path}`, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Bridge request failed: ${response.status}`);
    return payload;
  }
  function visibleQuestionContainers() {
    return Array.from(document.querySelectorAll('[role="listitem"], .Qr7Oae')).filter(isVisible).filter((node) => node.querySelector('[role="heading"]'));
  }
  function containerTitle(container) {
    const heading = container.querySelector('[role="heading"]');
    return normalize(heading?.textContent || "");
  }
  function findQuestionContainer(title) {
    return visibleQuestionContainers().find((container) => questionTitleMatches(containerTitle(container), title));
  }
  function visibleFieldSpecs(task) {
    return task.payload.fieldSpecs.filter((field) => findQuestionContainer(field.title));
  }
  function firstInput(container, selector) {
    return Array.from(container.querySelectorAll(selector)).find(isVisible) || null;
  }
  function labeledTextControl(container, labels) {
    for (const label of labels) {
      const directInput = firstInput(container, `input[aria-label="${label}"]`);
      if (directInput) return directInput;
      const nestedInput = firstInput(container, `[role="combobox"][aria-label="${label}"] input, [role="spinbutton"][aria-label="${label}"]`);
      if (nestedInput) return nestedInput;
    }
    return null;
  }
  function dispatchInput(input, value) {
    input.focus();
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.blur();
  }
  function timeParts(value) {
    const match = String(value || "").match(/^(\d{1,2}):(\d{1,2})$/);
    if (!match) return ["", ""];
    return [match[1].padStart(2, "0"), match[2].padStart(2, "0")];
  }
  async function fillTextLike(container, value) {
    const input = firstInput(container, 'input:not([type="hidden"]):not([type="date"]):not([type="number"])') || firstInput(container, "textarea");
    if (!input) return false;
    dispatchInput(input, String(value || ""));
    await sleep(80);
    return normalize(input.value) === normalize(value);
  }
  async function fillDate(container, value) {
    const input = firstInput(container, 'input[type="date"]');
    if (!input) return false;
    dispatchInput(input, String(value || ""));
    await sleep(80);
    return normalize(input.value) === normalize(value);
  }
  async function fillDateTime(container, value) {
    const inputDate = firstInput(container, 'input[type="date"]');
    const inputHour = labeledTextControl(container, ["時"]);
    const inputMinute = labeledTextControl(container, ["分"]);
    if (!inputDate || !inputHour || !inputMinute) return false;
    dispatchInput(inputDate, value?.date || "");
    const [hour, minute] = timeParts(value?.time || "");
    dispatchInput(inputHour, hour);
    dispatchInput(inputMinute, minute);
    await sleep(80);
    return normalize(inputDate.value) === normalize(value?.date || "") && normalize(inputHour.value) === hour && normalize(inputMinute.value) === minute;
  }
  async function fillDuration(container, value) {
    const durationInputs = Array.from(container.querySelectorAll('input:not([type="hidden"]):not([type="date"])')).filter(isVisible);
    const inputHour = labeledTextControl(container, ["時", "時間"]) || durationInputs[0] || null;
    const inputMinute = labeledTextControl(container, ["分"]) || durationInputs[1] || null;
    const inputSecond = labeledTextControl(container, ["秒"]) || durationInputs[2] || null;
    if (!inputHour || !inputMinute) return false;
    const [hour, minute] = timeParts(value);
    const hourValue = hour === "00" ? "" : String(Number(hour));
    const minuteValue = String(Number(minute || "0"));
    dispatchInput(inputHour, hourValue);
    dispatchInput(inputMinute, minuteValue);
    if (inputSecond) {
      dispatchInput(inputSecond, "");
    }
    await sleep(80);
    return normalize(inputHour.value) === normalize(hourValue)
      && normalize(inputMinute.value) === normalize(minuteValue)
      && (!inputSecond || normalize(inputSecond.value) === "");
  }
  function optionElements(container, role) {
    return Array.from(container.querySelectorAll(`[role="${role}"]`)).filter(isVisible);
  }
  function matchChoice(container, role, value) {
    const expected = normalize(value);
    return optionElements(container, role).find((node) => normalize(node.getAttribute("aria-label")) === expected)
      || optionElements(container, role).find((node) => normalize(node.getAttribute("data-value")) === expected)
      || optionElements(container, role).find((node) => normalize(node.textContent).startsWith(expected));
  }
  async function fillDropdown(container, value) {
    const listbox = firstInput(container, '[role="listbox"]') || container.querySelector('[role="listbox"]');
    if (!listbox) return false;
    listbox.click();
    await sleep(100);
    const option = Array.from(document.querySelectorAll('[role="option"]'))
      .filter(isVisible)
      .find((node) => {
        const expected = normalize(value);
        return normalize(node.getAttribute("aria-label")) === expected
          || normalize(node.getAttribute("data-value")) === expected
          || normalize(node.textContent).startsWith(expected);
      });
    if (!option) return false;
    option.click();
    await sleep(80);
    container.querySelector('[role="heading"]')?.click();
    await sleep(40);
    return true;
  }
  async function fillRadio(container, value) {
    const radio = matchChoice(container, "radio", value);
    if (!radio) return false;
    if (radio.getAttribute("aria-checked") !== "true") {
      radio.click();
      await sleep(80);
    }
    return radio.getAttribute("aria-checked") === "true";
  }
  async function fillCheckbox(container, values) {
    const expected = new Set((Array.isArray(values) ? values : [values]).map(normalize).filter(Boolean));
    if (expected.size === 0) return true;
    const checkboxes = optionElements(container, "checkbox");
    checkboxes.forEach((checkbox) => {
      const label = normalize(checkbox.getAttribute("aria-label") || checkbox.textContent);
      const shouldCheck = expected.has(label);
      const isChecked = checkbox.getAttribute("aria-checked") === "true";
      if (shouldCheck !== isChecked) checkbox.click();
    });
    await sleep(100);
    return Array.from(expected).every((value) => matchChoice(container, "checkbox", value)?.getAttribute("aria-checked") === "true");
  }
  async function fillField(field, container, value) {
    if (typeof value === "undefined" || value === null) return true;
    if (field.kind === "text" || field.kind === "textarea") return fillTextLike(container, value);
    if (field.kind === "dropdown") return fillDropdown(container, value);
    if (field.kind === "radio") return fillRadio(container, value);
    if (field.kind === "checkbox") return fillCheckbox(container, value);
    if (field.kind === "date") return fillDate(container, value);
    if (field.kind === "dateTime") return fillDateTime(container, value);
    if (field.kind === "duration") return fillDuration(container, value);
    return true;
  }
  function fieldSatisfied(field, container, expectedValue) {
    if (!field.required) return true;
    if (field.kind === "text" || field.kind === "textarea") {
      const input = firstInput(container, 'input:not([type="hidden"]):not([type="date"]):not([type="number"])') || firstInput(container, "textarea");
      return Boolean(normalize(input?.value));
    }
    if (field.kind === "dropdown") {
      const listbox = firstInput(container, '[role="listbox"]') || container.querySelector('[role="listbox"]');
      return Boolean(normalize(listbox?.textContent));
    }
    if (field.kind === "radio") {
      return expectedValue ? matchChoice(container, "radio", expectedValue)?.getAttribute("aria-checked") === "true" : optionElements(container, "radio").some((node) => node.getAttribute("aria-checked") === "true");
    }
    if (field.kind === "checkbox") {
      const expected = Array.isArray(expectedValue) ? expectedValue : [];
      return expected.length > 0
        ? expected.every((value) => matchChoice(container, "checkbox", value)?.getAttribute("aria-checked") === "true")
        : optionElements(container, "checkbox").some((node) => node.getAttribute("aria-checked") === "true");
    }
    if (field.kind === "date") return Boolean(normalize(firstInput(container, 'input[type="date"]')?.value));
    if (field.kind === "dateTime") {
      return Boolean(normalize(firstInput(container, 'input[type="date"]')?.value))
        && Boolean(normalize(labeledTextControl(container, ["時"])?.value))
        && Boolean(normalize(labeledTextControl(container, ["分"])?.value));
    }
    if (field.kind === "duration") {
      const durationInputs = Array.from(container.querySelectorAll('input:not([type="hidden"]):not([type="date"])')).filter(isVisible);
      const hourInput = labeledTextControl(container, ["時", "時間"]) || durationInputs[0] || null;
      const minuteInput = labeledTextControl(container, ["分"]) || durationInputs[1] || null;
      const secondInput = labeledTextControl(container, ["秒"]) || durationInputs[2] || null;
      return Boolean(normalize(hourInput?.value))
        && Boolean(normalize(minuteInput?.value))
        && (!secondInput || Boolean(normalize(secondInput?.value)));
    }
    return true;
  }
  function pageFingerprint() {
    return [
      visibleQuestionContainers().map(containerTitle).join("|"),
      Boolean(findButton(["送信", "Submit"])),
      Boolean(findButton(["次へ"])),
    ].join("::");
  }
  function findButton(labels) {
    const expected = labels.map(normalize);
    return Array.from(document.querySelectorAll('[role="button"]')).filter(isVisible).find((button) => expected.includes(normalize(button.textContent)));
  }
  async function waitForPageChange(previousFingerprint) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (pageFingerprint() !== previousFingerprint) return true;
      await sleep(120);
    }
    return false;
  }
  async function notifyAutofillComplete(taskId, missingQuestions, error) {
    if (runtime.notified) return;
    runtime.notified = true;
    if (error || (missingQuestions && missingQuestions.length > 0)) {
      clearPendingSubmitTask();
    } else {
      savePendingSubmitTask(taskId, currentFormKey());
    }
    await request(`/api/bridge/forms/${encodeURIComponent(taskId)}/autofill-complete`, {
      method: "POST",
      body: JSON.stringify({ missingQuestions, error: error || null }),
    });
    await browser.runtime.sendMessage({
      type: "GC_AUTOFILL_RELEASE",
      taskId,
      keep: Boolean(error || (missingQuestions && missingQuestions.length > 0)),
    });
  }
  async function notifySubmitted(taskId) {
    clearPendingSubmitTask();
    await request(`/api/bridge/forms/${encodeURIComponent(taskId)}/submitted`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    await browser.runtime.sendMessage({
      type: "GC_AUTOFILL_RELEASE",
      taskId,
      keep: false,
    });
  }
  async function claimTask(formKey) {
    if (runtime.task) return runtime.task;
    const payload = await browser.runtime.sendMessage({
      type: "GC_AUTOFILL_CLAIM",
      formKey,
      taskId: taskIdFromHash(),
    });
    runtime.task = payload?.task ?? null;
    return runtime.task;
  }
  async function processTask(task) {
    for (let index = 0; index < 8; index += 1) {
      const fields = visibleFieldSpecs(task);
      if (fields.length === 0 && !findButton(["送信", "Submit"]) && !findButton(["次へ"])) {
        throw new Error("フォームの質問を読み取れませんでした。");
      }
      const missingContainers = task.payload.fieldSpecs
        .filter((field) => field.required)
        .filter((field) => !findQuestionContainer(field.title))
        .map((field) => field.title);
      for (const field of fields) {
        const container = findQuestionContainer(field.title);
        if (!container) continue;
        await fillField(field, container, task.payload.answers[field.title]);
      }
      await sleep(150);
      const missingQuestions = fields
        .filter((field) => field.required)
        .filter((field) => {
          const container = findQuestionContainer(field.title);
          return container ? !fieldSatisfied(field, container, task.payload.answers[field.title]) : true;
        })
        .map((field) => field.title);
      const reviewHints = (task.payload.reviewHints || []).filter(Boolean);
      const combinedIssues = [...new Set([...missingQuestions, ...reviewHints])];
      const submitButton = findButton(["送信", "Submit"]);
      if (submitButton) {
        if (missingContainers.length > 0 && index < 7) {
          await sleep(250);
          continue;
        }
        await notifyAutofillComplete(task.id, combinedIssues, null);
        return;
      }
      if (missingQuestions.length > 0) {
        await notifyAutofillComplete(task.id, combinedIssues, null);
        return;
      }
      const nextButton = findButton(["次へ"]);
      if (!nextButton) {
        await notifyAutofillComplete(task.id, [], "次へボタンが見つかりませんでした。");
        return;
      }
      const fingerprint = pageFingerprint();
      nextButton.click();
      await waitForPageChange(fingerprint);
      await sleep(250);
    }
    throw new Error("フォームの自動入力がページ数上限を超えました。");
  }
  async function main() {
    if (runtime.started) return;
    runtime.started = true;
    const formKey = currentFormKey();
    if (isConfirmationScreen()) {
      const pendingTask = loadPendingSubmitTask();
      if (pendingTask?.taskId && (!pendingTask.formKey || !formKey || pendingTask.formKey === formKey)) {
        await notifySubmitted(pendingTask.taskId);
      }
      return;
    }
    if (!formKey) return;
    try {
      await sleep(250);
      const task = await claimTask(formKey);
      if (!task) return;
      await processTask(task);
    } catch (error) {
      if (runtime.task?.id) {
        await notifyAutofillComplete(runtime.task.id, [], error instanceof Error ? error.message : "Unknown autofill error");
      }
    }
  }
  window.setTimeout(() => { void main(); }, 250);
})();
