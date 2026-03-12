// ==UserScript==
// @name         GC Local Forms Bridge
// @namespace    local.gc.forms.bridge
// @version      0.1.0
// @description  Autofill Google Forms from the local dashboard and stop before submit.
// @match        https://docs.google.com/forms/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const LOCAL_BASE_URL = "http://127.0.0.1:3131";
  const FORM_IDS = {
    work_report: "1FAIpQLScX1kcDYuuEp3rNVGqIWVYQT4r5nTLXiFmKm4Dpfar7BVMSgQ",
    schedule_change: "1FAIpQLSdCborRTdo0u9Oicusv2NHoP1lwR8uhqZCShLl2uzFaxmzxeQ",
    handoff: "1FAIpQLSek3Acb1pm-vYtr8vbr7fVdLGKq615X8wv7SyClSUVeLNi4mw",
  };
  const BANNER_ID = "gc-local-bridge-banner";

  const runtime = {
    started: false,
    task: null,
    notified: false,
  };

  function normalize(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .replace(/\s+\*$/, "")
      .trim();
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function isVisible(node) {
    if (!node) {
      return false;
    }
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function currentFormKey() {
    const href = window.location.href;
    return Object.entries(FORM_IDS).find(([, formId]) => href.includes(formId))?.[0] ?? null;
  }

  function taskIdFromHash() {
    const raw = window.location.hash.replace(/^#/, "");
    if (!raw) {
      return null;
    }
    return new URLSearchParams(raw).get("gc-task");
  }

  function isConfirmationScreen() {
    const text = normalize(document.body.textContent);
    return (
      text.includes("回答を記録しました") ||
      text.includes("回答を受け付けました") ||
      text.includes("your response has been recorded")
    );
  }

  async function request(path, options) {
    const response = await fetch(`${LOCAL_BASE_URL}${path}`, {
      headers: {
        "Content-Type": "application/json",
      },
      ...options,
    });

    if (response.status === 404) {
      return null;
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || `Bridge request failed: ${response.status}`);
    }
    return payload;
  }

  function visibleQuestionContainers() {
    return Array.from(document.querySelectorAll('[role="listitem"], .Qr7Oae'))
      .filter(isVisible)
      .filter((node) => node.querySelector('[role="heading"]'));
  }

  function containerTitle(container) {
    const heading = container.querySelector('[role="heading"]');
    return normalize(heading?.textContent || "");
  }

  function findQuestionContainer(title) {
    const expected = normalize(title);
    return (
      visibleQuestionContainers().find((container) => containerTitle(container) === expected) ||
      visibleQuestionContainers().find((container) => containerTitle(container).startsWith(expected))
    );
  }

  function visibleFieldSpecs(task) {
    return task.payload.fieldSpecs.filter((field) => findQuestionContainer(field.title));
  }

  function firstInput(container, selector) {
    return Array.from(container.querySelectorAll(selector)).find(isVisible) || null;
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
    if (!match) {
      return ["", ""];
    }
    return [match[1].padStart(2, "0"), match[2].padStart(2, "0")];
  }

  async function fillTextLike(container, value) {
    const input =
      firstInput(container, 'input:not([type="hidden"]):not([type="date"]):not([type="number"])') ||
      firstInput(container, "textarea");
    if (!input) {
      return false;
    }
    dispatchInput(input, String(value || ""));
    await sleep(80);
    return normalize(input.value) === normalize(value);
  }

  async function fillDate(container, value) {
    const input = firstInput(container, 'input[type="date"]');
    if (!input) {
      return false;
    }
    dispatchInput(input, String(value || ""));
    await sleep(80);
    return normalize(input.value) === normalize(value);
  }

  async function fillDateTime(container, value) {
    const inputDate = firstInput(container, 'input[type="date"]');
    const inputHour = firstInput(container, 'input[aria-label="時"]');
    const inputMinute = firstInput(container, 'input[aria-label="分"]');
    if (!inputDate || !inputHour || !inputMinute) {
      return false;
    }

    dispatchInput(inputDate, value?.date || "");
    const [hour, minute] = timeParts(value?.time || "");
    dispatchInput(inputHour, hour);
    dispatchInput(inputMinute, minute);
    await sleep(80);
    return normalize(inputDate.value) === normalize(value?.date || "") && normalize(inputHour.value) === hour && normalize(inputMinute.value) === minute;
  }

  async function fillDuration(container, value) {
    const inputHour = firstInput(container, 'input[aria-label="時"]');
    const inputMinute = firstInput(container, 'input[aria-label="分"]');
    if (!inputHour || !inputMinute) {
      return false;
    }

    const [hour, minute] = timeParts(value);
    dispatchInput(inputHour, hour);
    dispatchInput(inputMinute, minute);
    await sleep(80);
    return normalize(inputHour.value) === hour && normalize(inputMinute.value) === minute;
  }

  function optionElements(container, role) {
    return Array.from(container.querySelectorAll(`[role="${role}"]`)).filter(isVisible);
  }

  function matchChoice(container, role, value) {
    const expected = normalize(value);
    return (
      optionElements(container, role).find((node) => normalize(node.getAttribute("aria-label")) === expected) ||
      optionElements(container, role).find((node) => normalize(node.getAttribute("data-value")) === expected) ||
      optionElements(container, role).find((node) => normalize(node.textContent).startsWith(expected))
    );
  }

  async function fillDropdown(container, value) {
    const listbox = firstInput(container, '[role="listbox"]') || container.querySelector('[role="listbox"]');
    const option = matchChoice(container, "option", value);
    if (!listbox || !option) {
      return false;
    }

    listbox.click();
    await sleep(60);
    option.click();
    await sleep(60);
    container.querySelector('[role="heading"]')?.click();
    await sleep(40);

    const selected =
      optionElements(container, "option").find((node) => node.getAttribute("aria-selected") === "true") ||
      option;
    return normalize(selected.getAttribute("data-value") || selected.textContent) === normalize(value);
  }

  async function fillRadio(container, value) {
    const radio = matchChoice(container, "radio", value);
    if (!radio) {
      return false;
    }
    if (radio.getAttribute("aria-checked") !== "true") {
      radio.click();
      await sleep(80);
    }
    return radio.getAttribute("aria-checked") === "true";
  }

  async function fillCheckbox(container, values) {
    const expected = new Set((Array.isArray(values) ? values : [values]).map(normalize).filter(Boolean));
    if (expected.size === 0) {
      return true;
    }

    const checkboxes = optionElements(container, "checkbox");
    checkboxes.forEach((checkbox) => {
      const label = normalize(checkbox.getAttribute("aria-label") || checkbox.textContent);
      const shouldCheck = expected.has(label);
      const isChecked = checkbox.getAttribute("aria-checked") === "true";
      if (shouldCheck !== isChecked) {
        checkbox.click();
      }
    });
    await sleep(100);

    return Array.from(expected).every((value) => {
      const checkbox = matchChoice(container, "checkbox", value);
      return checkbox?.getAttribute("aria-checked") === "true";
    });
  }

  async function fillField(field, container, value) {
    if (typeof value === "undefined" || value === null) {
      return true;
    }

    if (field.kind === "text" || field.kind === "textarea") {
      return fillTextLike(container, value);
    }
    if (field.kind === "dropdown") {
      return fillDropdown(container, value);
    }
    if (field.kind === "radio") {
      return fillRadio(container, value);
    }
    if (field.kind === "checkbox") {
      return fillCheckbox(container, value);
    }
    if (field.kind === "date") {
      return fillDate(container, value);
    }
    if (field.kind === "dateTime") {
      return fillDateTime(container, value);
    }
    if (field.kind === "duration") {
      return fillDuration(container, value);
    }
    return true;
  }

  function fieldSatisfied(field, container, expectedValue) {
    if (!field.required) {
      return true;
    }

    if (field.kind === "text" || field.kind === "textarea") {
      const input =
        firstInput(container, 'input:not([type="hidden"]):not([type="date"]):not([type="number"])') ||
        firstInput(container, "textarea");
      return Boolean(normalize(input?.value));
    }

    if (field.kind === "dropdown") {
      const selected = optionElements(container, "option").find((node) => node.getAttribute("aria-selected") === "true");
      const value = normalize(selected?.getAttribute("data-value") || selected?.textContent);
      return Boolean(value && value !== "選択");
    }

    if (field.kind === "radio") {
      if (expectedValue) {
        return matchChoice(container, "radio", expectedValue)?.getAttribute("aria-checked") === "true";
      }
      return optionElements(container, "radio").some((node) => node.getAttribute("aria-checked") === "true");
    }

    if (field.kind === "checkbox") {
      const expected = Array.isArray(expectedValue) ? expectedValue : [];
      if (expected.length > 0) {
        return expected.every((value) => matchChoice(container, "checkbox", value)?.getAttribute("aria-checked") === "true");
      }
      return optionElements(container, "checkbox").some((node) => node.getAttribute("aria-checked") === "true");
    }

    if (field.kind === "date") {
      return Boolean(normalize(firstInput(container, 'input[type="date"]')?.value));
    }

    if (field.kind === "dateTime") {
      return (
        Boolean(normalize(firstInput(container, 'input[type="date"]')?.value)) &&
        Boolean(normalize(firstInput(container, 'input[aria-label="時"]')?.value)) &&
        Boolean(normalize(firstInput(container, 'input[aria-label="分"]')?.value))
      );
    }

    if (field.kind === "duration") {
      return Boolean(normalize(firstInput(container, 'input[aria-label="時"]')?.value) || normalize(firstInput(container, 'input[aria-label="分"]')?.value));
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
    return Array.from(document.querySelectorAll('[role="button"]'))
      .filter(isVisible)
      .find((button) => expected.includes(normalize(button.textContent)));
  }

  function parseFormDefinitionTitles() {
    const loadData = window.FB_PUBLIC_LOAD_DATA_;
    if (!Array.isArray(loadData)) {
      return new Set();
    }

    const sections = Array.isArray(loadData[1]) ? loadData[1] : [];
    const items = Array.isArray(sections[1]) ? sections[1] : [];
    const titles = new Set();

    items.forEach((item) => {
      if (Array.isArray(item) && typeof item[1] === "string") {
        titles.add(normalize(item[1]));
      }
    });

    return titles;
  }

  function renderBanner(message, tone) {
    let banner = document.getElementById(BANNER_ID);
    if (!banner) {
      banner = document.createElement("aside");
      banner.id = BANNER_ID;
      banner.style.position = "fixed";
      banner.style.right = "16px";
      banner.style.bottom = "16px";
      banner.style.zIndex = "999999";
      banner.style.maxWidth = "420px";
      banner.style.padding = "14px 16px";
      banner.style.borderRadius = "12px";
      banner.style.boxShadow = "0 18px 40px rgba(0, 0, 0, 0.18)";
      banner.style.fontFamily = "system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
      banner.style.fontSize = "14px";
      banner.style.lineHeight = "1.5";
      banner.style.whiteSpace = "pre-wrap";
      document.body.appendChild(banner);
    }

    if (tone === "error") {
      banner.style.background = "#7f1d1d";
      banner.style.color = "#ffffff";
    } else if (tone === "warning") {
      banner.style.background = "#fff7ed";
      banner.style.color = "#9a3412";
    } else {
      banner.style.background = "#ecfeff";
      banner.style.color = "#155e75";
    }

    banner.textContent = message;
  }

  async function notifyAutofillComplete(taskId, missingQuestions, error) {
    if (runtime.notified) {
      return;
    }
    runtime.notified = true;
    await request(`/api/bridge/forms/${encodeURIComponent(taskId)}/autofill-complete`, {
      method: "POST",
      body: JSON.stringify({
        missingQuestions,
        error: error || null,
      }),
    });
  }

  async function claimTask(formKey) {
    if (runtime.task) {
      return runtime.task;
    }

    const payload = await request("/api/bridge/forms/claim-next", {
      method: "POST",
      body: JSON.stringify({
        formKey,
        taskId: taskIdFromHash(),
      }),
    });

    runtime.task = payload?.task ?? null;
    return runtime.task;
  }

  async function waitForPageChange(previousFingerprint) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (pageFingerprint() !== previousFingerprint) {
        return true;
      }
      await sleep(120);
    }
    return false;
  }

  async function processTask(task) {
    const metadataTitles = parseFormDefinitionTitles();

    for (let index = 0; index < 5; index += 1) {
      const fields = visibleFieldSpecs(task);
      if (fields.length === 0 && !findButton(["送信", "Submit"]) && !findButton(["次へ"])) {
        return;
      }

      for (const field of fields) {
        const container = findQuestionContainer(field.title);
        if (!container) {
          continue;
        }
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

      const metadataDrift = task.payload.fieldSpecs
        .filter((field) => !metadataTitles.has(normalize(field.title)))
        .map((field) => field.title);

      const submitButton = findButton(["送信", "Submit"]);
      if (submitButton) {
        const allMissing = Array.from(new Set([...missingQuestions, ...metadataDrift]));
        const tone = allMissing.length > 0 ? "warning" : "success";
        renderBanner(
          allMissing.length > 0
            ? `内容確認後に手動送信してください。\n未充足または要確認の項目: ${allMissing.join(" / ")}`
            : "内容確認後に手動送信してください。",
          tone,
        );
        await notifyAutofillComplete(task.id, allMissing, null);
        return;
      }

      if (missingQuestions.length > 0) {
        renderBanner(`自動入力が止まりました。\n不足項目: ${missingQuestions.join(" / ")}`, "error");
        await notifyAutofillComplete(task.id, missingQuestions, null);
        return;
      }

      const nextButton = findButton(["次へ"]);
      if (!nextButton) {
        renderBanner("次のページに進めませんでした。内容を確認してください。", "error");
        await notifyAutofillComplete(task.id, [], "Next button was not found.");
        return;
      }

      const fingerprint = pageFingerprint();
      nextButton.click();
      await waitForPageChange(fingerprint);
      await sleep(250);
    }

    throw new Error("Autofill exceeded the expected page count.");
  }

  async function main() {
    if (runtime.started) {
      return;
    }
    runtime.started = true;

    const formKey = currentFormKey();
    if (!formKey || isConfirmationScreen()) {
      return;
    }

    try {
      await sleep(250);
      const task = await claimTask(formKey);
      if (!task) {
        if (taskIdFromHash()) {
          renderBanner("下書き task が見つかりませんでした。ダッシュボード側を確認してください。", "error");
        }
        return;
      }

      await processTask(task);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown bridge error.";
      renderBanner(`自動入力エラー: ${message}`, "error");
      if (runtime.task?.id) {
        await notifyAutofillComplete(runtime.task.id, [], message);
      }
    }
  }

  window.setTimeout(() => {
    void main();
  }, 200);
})();
