import type { FormDefinition, FormFieldDefinition } from "./types.js";
import { normalizeText } from "./utils.js";

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseOptions(questionMeta: unknown): string[] {
  const questionRow = asArray(questionMeta);
  const optionRows = asArray(questionRow[1]);
  return optionRows
    .map((row) => asArray(row)[0])
    .filter((option): option is string => typeof option === "string")
    .map((option) => normalizeText(option));
}

export function parseFormDefinition(loadData: unknown, fallbackTitle = ""): FormDefinition {
  const topLevel = asArray(loadData);
  const formTitle = typeof topLevel[2] === "string" ? topLevel[2] : fallbackTitle;
  const items = asArray(asArray(topLevel[1])[1]);
  const parsedItems: FormFieldDefinition[] = [];

  items.forEach((item) => {
    const row = asArray(item);
    const title = typeof row[1] === "string" ? normalizeText(row[1]) : "";
    const typeCode = typeof row[3] === "number" ? row[3] : -1;
    const questions = asArray(row[4]);

    if (!title || questions.length === 0) {
      return;
    }

    questions.forEach((question) => {
      const questionRow = asArray(question);
      const entryId = questionRow[0];

      if (typeof entryId !== "number") {
        return;
      }

      parsedItems.push({
        entryId,
        title,
        typeCode,
        options: parseOptions(question),
        helpText: typeof row[2] === "string" ? normalizeText(row[2]) : undefined,
      });
    });
  });

  return {
    title: normalizeText(formTitle),
    items: parsedItems,
  };
}
