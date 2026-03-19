// @ts-nocheck
import { existsSync, readFileSync } from "node:fs";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

import { CHROME_EXECUTABLE_PATH } from "./env.js";
import type { AutofillTaskRecord } from "./types.js";

function chromeLaunchError(): Error {
  if (!existsSync(CHROME_EXECUTABLE_PATH)) {
    return new Error(`Chrome が見つかりません。${CHROME_EXECUTABLE_PATH} を確認してください。`);
  }
  return new Error("Chrome を起動できませんでした。");
}

async function launchAutofillBrowser(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    executablePath: CHROME_EXECUTABLE_PATH,
    args: [
      "--disable-blink-features=AutomationControlled",
    ],
  }).catch((error) => {
    throw error instanceof Error ? error : chromeLaunchError();
  });
}

function formIdForTask(task: AutofillTaskRecord): string | null {
  if (task.formKey === "work_report") return "1FAIpQLScX1kcDYuuEp3rNVGqIWVYQT4r5nTLXiFmKm4Dpfar7BVMSgQ";
  if (task.formKey === "schedule_change") return "1FAIpQLSdCborRTdo0u9Oicusv2NHoP1lwR8uhqZCShLl2uzFaxmzxeQ";
  if (task.formKey === "handoff") return "1FAIpQLSek3Acb1pm-vYtr8vbr7fVdLGKq615X8wv7SyClSUVeLNi4mw";
  return null;
}

async function targetPage(context: BrowserContext, task: AutofillTaskRecord): Promise<Page> {
  return context.newPage();
}

async function fillVisibleDropdowns(page: Page, task: AutofillTaskRecord): Promise<void> {
  const normalize = (value: unknown) =>
    String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .replace(/\s+\*$/, "")
      .trim();
  const normalizeLoose = (value: unknown) => normalize(value).replace(/\s+/g, "");

  for (const field of task.payload.fieldSpecs.filter((item) => item.kind === "dropdown")) {
    const answer = String(task.payload.answers[field.title] || "").trim();
    if (!answer) {
      continue;
    }
    const headings = page.locator('[role="heading"]');
    const headingCount = await headings.count();
    let listbox = null;

    for (let index = 0; index < headingCount; index += 1) {
      const heading = headings.nth(index);
      const headingText = normalize(await heading.textContent().catch(() => ""));
      if (!(headingText === normalize(field.title) || headingText.startsWith(normalize(field.title)))) {
        continue;
      }
      const container = heading.locator('xpath=ancestor::*[@role="listitem" or contains(@class,"Qr7Oae")][1]');
      const candidate = container.locator('[role="listbox"]').first();
      if (await candidate.count()) {
        listbox = candidate;
        break;
      }
    }

    if (!listbox) {
      continue;
    }

    await listbox.scrollIntoViewIfNeeded().catch(() => {});
    await listbox.click();
    await page.waitForTimeout(160);

    const options = page.locator('[role="option"]');
    const optionCount = await options.count();
    let matchedIndex = -1;
    const expected = normalize(answer);
    const expectedLoose = normalizeLoose(answer);

    for (let index = 0; index < optionCount; index += 1) {
      const option = options.nth(index);
      const [textContent, ariaLabel, dataValue] = await Promise.all([
        option.textContent().catch(() => ""),
        option.getAttribute("aria-label").catch(() => ""),
        option.getAttribute("data-value").catch(() => ""),
      ]);
      const candidates = [textContent, ariaLabel, dataValue].map((value) => normalize(value)).filter(Boolean);
      const looseCandidates = candidates.map((value) => normalizeLoose(value));
      if (
        candidates.some((value) => value === expected || value.startsWith(expected))
        || looseCandidates.some((value) => value === expectedLoose || value.startsWith(expectedLoose))
      ) {
        matchedIndex = index;
        break;
      }
    }

    if (matchedIndex === -1) {
      await page.keyboard.press("Escape").catch(() => {});
      continue;
    }

    const option = options.nth(matchedIndex);
    await option.scrollIntoViewIfNeeded().catch(() => {});
    await option.click();
    await page.waitForTimeout(220);

    const selectedOptions = page.locator('[role="option"][aria-selected="true"]');
    const selectedCount = await selectedOptions.count();
    let selected = false;
    for (let index = 0; index < selectedCount; index += 1) {
      const optionNode = selectedOptions.nth(index);
      const [textContent, ariaLabel, dataValue] = await Promise.all([
        optionNode.textContent().catch(() => ""),
        optionNode.getAttribute("aria-label").catch(() => ""),
        optionNode.getAttribute("data-value").catch(() => ""),
      ]);
      const candidates = [textContent, ariaLabel, dataValue].map((value) => normalize(value)).filter(Boolean);
      const looseCandidates = candidates.map((value) => normalizeLoose(value));
      if (
        candidates.some((value) => value !== "選択" && (value === expected || value.startsWith(expected)))
        || looseCandidates.some((value) => value !== "選択" && (value === expectedLoose || value.startsWith(expectedLoose)))
      ) {
        selected = true;
        break;
      }
    }

    if (!selected) {
      await page.keyboard.press("Escape").catch(() => {});
    }
  }
}

function autofillDomRunnerSource(): string {
  return readFileSync(new URL("./autofill-dom-runner.js", import.meta.url), "utf8");
}

async function evaluateAutofill(page: Page, task: AutofillTaskRecord): Promise<{
  submitReady: boolean;
  missingQuestions: string[];
  error: string | null;
}> {
  return page.evaluate(
    async ({ inputTask, sourceText }) => {
      (0, eval)(sourceText);
      const runner = (window as typeof window & {
        __gcAutofillRunner?: (taskValue: unknown) => Promise<{
          submitReady: boolean;
          missingQuestions: string[];
          error: string | null;
        }>;
      }).__gcAutofillRunner;
      if (typeof runner !== "function") {
        return {
          submitReady: false,
          missingQuestions: [],
          error: "フォーム自動入力ランナーを読み込めませんでした。",
        };
      }
      return runner(inputTask);
    },
    {
      inputTask: task,
      sourceText: autofillDomRunnerSource(),
    },
  );
}

async function submitPreparedForm(page: Page): Promise<void> {
  const submitButton = page.getByRole("button", { name: /^(送信|Submit)$/ });
  if (!await submitButton.count()) {
    throw new Error("送信ボタンが見つかりませんでした。");
  }
  await submitButton.first().click();
  await Promise.race([
    page.waitForFunction(() => {
      const text = document.body?.innerText || "";
      return /回答を記録しました|回答を受け付けました|Your response has been recorded|Thanks for your response/i.test(text);
    }, { timeout: 10000 }),
    page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => null),
  ]);
}

export async function runAutofillTask(task: AutofillTaskRecord): Promise<{
  missingQuestions: string[];
  error: string | null;
  submitReady: boolean;
  pageUrl: string;
}> {
  if (!existsSync(CHROME_EXECUTABLE_PATH)) {
    throw chromeLaunchError();
  }
  const browser = await launchAutofillBrowser();
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 980 },
    });
    const page = await targetPage(context, task);
    await page.goto(task.launchUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(600);
    const currentUrl = page.url();
    if (currentUrl.includes("accounts.google.com")) {
      return {
        missingQuestions: [],
        error: "Google Forms へのログインが必要です。フォーム公開設定を確認してください。",
        submitReady: false,
        pageUrl: currentUrl,
      };
    }
    let result:
      | {
          submitReady: boolean;
          missingQuestions: string[];
          error: string | null;
        }
      | null = null;
    const dropdownTitles = new Set(task.payload.fieldSpecs.filter((item) => item.kind === "dropdown").map((item) => item.title));
    for (let index = 0; index < 6; index += 1) {
      await fillVisibleDropdowns(page, task);
      try {
        result = await evaluateAutofill(page, task);
        if (result.submitReady || result.error) {
          break;
        }
        const waitingOnDropdown = result.missingQuestions.some((question) => dropdownTitles.has(question));
        if (!waitingOnDropdown || index === 5) {
          break;
        }
        await page.waitForTimeout(300);
        continue;
      } catch (error) {
        if (error instanceof Error && error.message.includes("Execution context was destroyed")) {
          await page.waitForLoadState("domcontentloaded");
          await page.waitForTimeout(400);
          continue;
        }
        throw error;
      }
    }
    if (!result) {
      result = {
        submitReady: false,
        missingQuestions: [],
        error: "フォームの自動入力がページ遷移上限を超えました。",
      };
    }
    if (result.submitReady && !result.error) {
      try {
        await submitPreparedForm(page);
      } catch (error) {
        return {
          missingQuestions: result.missingQuestions,
          error: error instanceof Error ? error.message : String(error),
          submitReady: false,
          pageUrl: page.url(),
        };
      }
    }
    return {
      ...result,
      pageUrl: page.url(),
    };
  } finally {
    await browser.close().catch(() => {});
  }
}
