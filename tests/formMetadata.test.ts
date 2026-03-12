import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseFormDefinition } from "../src/formMetadata.js";

function loadFixture(name: string) {
  return JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures/forms", name), "utf8"));
}

describe("parseFormDefinition", () => {
  it("parses work report field titles and options", () => {
    const definition = parseFormDefinition(loadFixture("work-report.json"));
    expect(definition.title).toBe("作業時間報告-2025年度");
    expect(definition.items.map((item) => item.title)).toEqual(["メールアドレス", "お名前_漢字フルネーム", "該当作業"]);
    expect(definition.items[2]).toMatchObject({
      entryId: 1003,
      typeCode: 2,
      options: ["コーチング", "コーチング以外"],
    });
  });

  it("parses schedule change date-time questions", () => {
    const definition = parseFormDefinition(loadFixture("schedule-change.json"));
    expect(definition.title).toBe("コーチング日程変更フォーム");
    expect(definition.items[1]).toMatchObject({
      entryId: 2002,
      title: "調整前(通常時)のコーチング時間を教えてください。",
      typeCode: 9,
    });
  });

  it("parses handoff radio options", () => {
    const definition = parseFormDefinition(loadFixture("handoff.json"));
    expect(definition.title).toBe("引き継ぎフォーム");
    expect(definition.items[1]).toMatchObject({
      entryId: 3002,
      options: ["アドバンス/プレミアムコース（週2,3回）", "コーチ変更引き継ぎ", "代行引き継ぎ"],
    });
  });
});
