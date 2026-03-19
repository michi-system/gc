window.__gcAutofillRunner = async function (inputTask) {
  function normalize(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .replace(/\s+\*$/, "")
      .trim();
  }
  function questionTitleVariants(value) {
    const normalized = normalize(value);
    const variants = new Set([normalized]);
    const withoutNote = normalized.split("※")[0] && normalized.split("※")[0].trim();
    if (withoutNote) variants.add(withoutNote);
    const firstLine = normalized.split("\n")[0] && normalized.split("\n")[0].trim();
    if (firstLine) variants.add(firstLine);
    return Array.from(variants).filter(Boolean);
  }
  function questionTitleMatches(actual, expected) {
    const actualVariants = questionTitleVariants(actual);
    const expectedVariants = questionTitleVariants(expected);
    return actualVariants.some((actualValue) =>
      expectedVariants.some((expectedValue) =>
        actualValue === expectedValue
        || actualValue.startsWith(expectedValue)
        || expectedValue.startsWith(actualValue),
      ),
    );
  }
  function normalizeLoose(value) {
    return normalize(value).replace(/\s+/g, "");
  }
  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }
  function isVisible(node) {
    if (!node) return false;
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function visibleQuestionContainers() {
    return Array.from(document.querySelectorAll('[role="listitem"], .Qr7Oae'))
      .filter(isVisible)
      .filter((node) => node.querySelector('[role="heading"]'));
  }
  function containerTitle(container) {
    const heading = container.querySelector('[role="heading"]');
    return normalize((heading && heading.textContent) || "");
  }
  function findQuestionContainer(title) {
    return visibleQuestionContainers().find((container) => questionTitleMatches(containerTitle(container), title));
  }
  function visibleFieldSpecs(taskValue) {
    return taskValue.payload.fieldSpecs.filter((field) => findQuestionContainer(field.title));
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
    dispatchInput(inputDate, (value && value.date) || "");
    const parts = timeParts((value && value.time) || "");
    dispatchInput(inputHour, parts[0]);
    dispatchInput(inputMinute, parts[1]);
    await sleep(80);
    return normalize(inputDate.value) === normalize((value && value.date) || "")
      && normalize(inputHour.value) === parts[0]
      && normalize(inputMinute.value) === parts[1];
  }
  async function fillDuration(container, value) {
    const durationInputs = Array.from(container.querySelectorAll('input:not([type="hidden"]):not([type="date"])'))
      .filter(isVisible);
    const inputHour = labeledTextControl(container, ["時", "時間"])
      || durationInputs[0]
      || null;
    const inputMinute = labeledTextControl(container, ["分"])
      || durationInputs[1]
      || null;
    const inputSecond = labeledTextControl(container, ["秒"])
      || durationInputs[2]
      || null;
    if (!inputHour || !inputMinute) return false;
    const parts = timeParts(value);
    const hourValue = parts[0] === "00" ? "" : String(Number(parts[0]));
    const minuteValue = String(Number(parts[1] || "0"));
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
    const expectedLoose = normalizeLoose(value);
    return optionElements(container, role).find((node) => normalize(node.getAttribute("aria-label")) === expected)
      || optionElements(container, role).find((node) => normalize(node.getAttribute("data-value")) === expected)
      || optionElements(container, role).find((node) => normalize(node.textContent).startsWith(expected))
      || optionElements(container, role).find((node) => normalizeLoose(node.getAttribute("aria-label")) === expectedLoose)
      || optionElements(container, role).find((node) => normalizeLoose(node.getAttribute("data-value")) === expectedLoose)
      || optionElements(container, role).find((node) => normalizeLoose(node.textContent).startsWith(expectedLoose));
  }
  function selectedDropdownValueMatches(expectedValue) {
    const expected = normalize(expectedValue);
    const expectedLoose = normalizeLoose(expectedValue);
    const candidates = Array.from(document.querySelectorAll('[role="option"][aria-selected="true"]'))
      .map((node) => normalize(node.getAttribute("data-value") || node.getAttribute("aria-label") || node.textContent || ""))
      .filter(Boolean)
      .filter((value) => value !== "選択");
    if (candidates.length === 0) return false;
    return candidates.some((value) => {
      return value === expected
        || normalizeLoose(value) === expectedLoose
        || value.startsWith(expected)
        || normalizeLoose(value).startsWith(expectedLoose);
    });
  }
  async function fillDropdown(container, value) {
    const listbox = firstInput(container, '[role="listbox"]') || container.querySelector('[role="listbox"]');
    if (!listbox) return false;
    listbox.click();
    await sleep(140);
    const option = Array.from(document.querySelectorAll('[role="option"]'))
      .filter(isVisible)
      .find((node) => {
        const expected = normalize(value);
        const expectedLoose = normalizeLoose(value);
        return normalize(node.getAttribute("aria-label")) === expected
          || normalize(node.getAttribute("data-value")) === expected
          || normalize(node.textContent).startsWith(expected)
          || normalizeLoose(node.getAttribute("aria-label")) === expectedLoose
          || normalizeLoose(node.getAttribute("data-value")) === expectedLoose
          || normalizeLoose(node.textContent).startsWith(expectedLoose);
      });
    if (!option) return false;
    option.click();
    await sleep(220);
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
    return Array.from(expected).every((value) => {
      const match = matchChoice(container, "checkbox", value);
      return match && match.getAttribute("aria-checked") === "true";
    });
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
      return Boolean(normalize(input && input.value));
    }
    if (field.kind === "dropdown") {
      if (expectedValue) {
        return selectedDropdownValueMatches(expectedValue);
      }
      return Array.from(document.querySelectorAll('[role="option"][aria-selected="true"]'))
        .some((node) => {
          const selectedText = normalize(node.getAttribute("data-value") || node.getAttribute("aria-label") || node.textContent || "");
          return selectedText && selectedText !== "選択";
        });
    }
    if (field.kind === "radio") {
      if (expectedValue) {
        const match = matchChoice(container, "radio", expectedValue);
        return Boolean(match && match.getAttribute("aria-checked") === "true");
      }
      return optionElements(container, "radio").some((node) => node.getAttribute("aria-checked") === "true");
    }
    if (field.kind === "checkbox") {
      const expected = Array.isArray(expectedValue) ? expectedValue : [];
      if (expected.length > 0) {
        return expected.every((value) => {
          const match = matchChoice(container, "checkbox", value);
          return Boolean(match && match.getAttribute("aria-checked") === "true");
        });
      }
      return optionElements(container, "checkbox").some((node) => node.getAttribute("aria-checked") === "true");
    }
    if (field.kind === "date") return Boolean(normalize(firstInput(container, 'input[type="date"]') && firstInput(container, 'input[type="date"]').value));
    if (field.kind === "dateTime") {
      return Boolean(normalize(firstInput(container, 'input[type="date"]') && firstInput(container, 'input[type="date"]').value))
        && Boolean(normalize(labeledTextControl(container, ["時"]) && labeledTextControl(container, ["時"]).value))
        && Boolean(normalize(labeledTextControl(container, ["分"]) && labeledTextControl(container, ["分"]).value));
    }
    if (field.kind === "duration") {
      const durationInputs = Array.from(container.querySelectorAll('input:not([type="hidden"]):not([type="date"])'))
        .filter(isVisible);
      const hourInput = labeledTextControl(container, ["時", "時間"])
        || durationInputs[0]
        || null;
      const minuteInput = labeledTextControl(container, ["分"])
        || durationInputs[1]
        || null;
      const secondInput = labeledTextControl(container, ["秒"])
        || durationInputs[2]
        || null;
      const hourValue = normalize((hourInput && hourInput.value) || "");
      const minuteValue = normalize((minuteInput && minuteInput.value) || "");
      const secondValue = normalize((secondInput && secondInput.value) || "");
      return Boolean(hourValue || minuteValue || secondValue);
    }
    return true;
  }
  function findButton(labels) {
    const expected = labels.map(normalize);
    return Array.from(document.querySelectorAll('[role="button"]')).filter(isVisible).find((button) => expected.includes(normalize(button.textContent)));
  }
  function pageFingerprint() {
    return [
      visibleQuestionContainers().map(containerTitle).join("|"),
      Boolean(findButton(["送信", "Submit"])),
      Boolean(findButton(["次へ"])),
    ].join("::");
  }
  async function waitForPageChange(previousFingerprint) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (pageFingerprint() !== previousFingerprint) return true;
      await sleep(120);
    }
    return false;
  }

  await sleep(250);
  for (let index = 0; index < 8; index += 1) {
    const fields = visibleFieldSpecs(inputTask);
    if (fields.length === 0 && !findButton(["送信", "Submit"]) && !findButton(["次へ"])) {
      return { submitReady: false, missingQuestions: [], error: "フォームの質問を読み取れませんでした。" };
    }
    const missingContainers = inputTask.payload.fieldSpecs
      .filter((field) => field.required)
      .filter((field) => !findQuestionContainer(field.title))
      .map((field) => field.title);
    for (const field of fields) {
      const container = findQuestionContainer(field.title);
      if (!container) continue;
      await fillField(field, container, inputTask.payload.answers[field.title]);
    }
    await sleep(260);
    const missingQuestions = fields
      .filter((field) => field.required)
      .filter((field) => {
        const container = findQuestionContainer(field.title);
        return container ? !fieldSatisfied(field, container, inputTask.payload.answers[field.title]) : true;
      })
      .map((field) => field.title);
    const submitButton = findButton(["送信", "Submit"]);
    if (submitButton) {
      if (missingContainers.length > 0 && index < 7) {
        await sleep(250);
        continue;
      }
      return {
        submitReady: true,
        missingQuestions: Array.from(new Set(missingQuestions.concat(inputTask.payload.reviewHints || []))),
        error: null,
      };
    }
    if (missingQuestions.length > 0) {
      return { submitReady: false, missingQuestions: missingQuestions, error: null };
    }
    const nextButton = findButton(["次へ"]);
    if (!nextButton) {
      return { submitReady: false, missingQuestions: [], error: "次へボタンが見つかりませんでした。" };
    }
    const fingerprint = pageFingerprint();
    nextButton.click();
    await waitForPageChange(fingerprint);
    await sleep(250);
  }
  return { submitReady: false, missingQuestions: [], error: "フォームの自動入力がページ数上限を超えました。" };
};
