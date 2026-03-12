import type { AnswerValue } from "./types.js";

export function nowIso(): string {
  return new Date().toISOString();
}

export function normalizeText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeLooseText(value: string | null | undefined): string {
  return normalizeText(value).replace(/[:：]$/, "");
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function titlePattern(title: string): RegExp {
  const normalized = normalizeLooseText(title);
  return new RegExp(escapeRegExp(normalized).replace(/\s+/g, "\\s+"), "i");
}

export function ensureArray<T>(value: T | T[] | undefined): T[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "undefined") {
    return [];
  }
  return [value];
}

export function inferDateFromIso(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

export function inferTimeFromIso(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

export function durationToHoursMinutes(startAt: string, endAt: string): string {
  const diffMs = Math.max(0, new Date(endAt).getTime() - new Date(startAt).getTime());
  const minutes = Math.round(diffMs / 60000);
  const hoursPart = Math.floor(minutes / 60);
  const minutesPart = minutes % 60;
  return `${hoursPart}:${String(minutesPart).padStart(2, "0")}`;
}

export function asString(value: AnswerValue | undefined): string {
  if (!value) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  if (typeof value === "string") {
    return value;
  }
  if (value.date && value.time) {
    return `${value.date} ${value.time}`;
  }
  return value.date ?? value.time ?? "";
}

export function isNonEmptyAnswer(value: AnswerValue | undefined): boolean {
  if (typeof value === "undefined") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0 && value.some((entry) => normalizeText(entry).length > 0);
  }
  if (typeof value === "string") {
    return normalizeText(value).length > 0;
  }
  return Boolean(normalizeText(value.date).length || normalizeText(value.time).length);
}
