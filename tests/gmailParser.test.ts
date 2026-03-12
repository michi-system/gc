import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseGmailSubmission } from "../src/gmailParser.js";

function loadFixture(name: string) {
  return JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures/gmail", name), "utf8"));
}

describe("parseGmailSubmission", () => {
  it("parses coaching work report copies", () => {
    const submission = parseGmailSubmission(loadFixture("work-report-coaching.json"));
    expect(submission).not.toBeNull();
    expect(submission?.formType).toBe("work_report_coaching");
    expect(submission?.matchGroupKey).toBe("2026-03-11:ST001:コーチング");
    expect(submission?.answers["今日の振り返り"]).toBe("コーチング通知botへ今日の面談を実施する連絡をしましたか？");
  });

  it("parses schedule change date-time answers into a stable match key", () => {
    const submission = parseGmailSubmission(loadFixture("schedule-change.json"));
    expect(submission).not.toBeNull();
    expect(submission?.formType).toBe("schedule_change");
    expect(submission?.matchGroupKey).toBe("山田 太郎:2026-03-10 18:00:2026-03-12 19:30");
    expect(submission?.answers["調整前(通常時)のコーチング時間を教えてください。"]).toEqual(["2026/03/10", "18:00"]);
  });

  it("parses handoff copies without depending on submission date", () => {
    const submission = parseGmailSubmission(loadFixture("handoff.json"));
    expect(submission).not.toBeNull();
    expect(submission?.formType).toBe("handoff");
    expect(submission?.matchGroupKey).toBe("ST001:アドバンス/プレミアムコース（週2,3回）");
  });
});
