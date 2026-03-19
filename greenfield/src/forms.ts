import type { AnswerValue, TaskFieldSpec } from "./types.js";

export type GreenfieldFormType =
  | "work_report_coaching"
  | "work_report_non_coaching"
  | "schedule_change"
  | "handoff";

export type HandoffPolicy = "advance_premium" | "coach_change" | "substitute";

export const FORM_URLS = {
  work_report: "https://docs.google.com/forms/d/e/1FAIpQLScX1kcDYuuEp3rNVGqIWVYQT4r5nTLXiFmKm4Dpfar7BVMSgQ/viewform",
  schedule_change: "https://docs.google.com/forms/d/e/1FAIpQLSdCborRTdo0u9Oicusv2NHoP1lwR8uhqZCShLl2uzFaxmzxeQ/viewform",
  handoff: "https://docs.google.com/forms/d/e/1FAIpQLSek3Acb1pm-vYtr8vbr7fVdLGKq615X8wv7SyClSUVeLNi4mw/viewform",
} as const;

export const FORM_IDS = {
  work_report: "1FAIpQLScX1kcDYuuEp3rNVGqIWVYQT4r5nTLXiFmKm4Dpfar7BVMSgQ",
  schedule_change: "1FAIpQLSdCborRTdo0u9Oicusv2NHoP1lwR8uhqZCShLl2uzFaxmzxeQ",
  handoff: "1FAIpQLSek3Acb1pm-vYtr8vbr7fVdLGKq615X8wv7SyClSUVeLNi4mw",
} as const;

const WORK_REPORT_COMMON_FIELDS: TaskFieldSpec[] = [
  { title: "メールアドレス", kind: "text", required: true },
  { title: "お名前_漢字フルネーム", kind: "dropdown", required: true },
  { title: "コーチコード", kind: "text", required: true },
  { title: "作業日時", kind: "date", required: true },
  { title: "該当作業", kind: "radio", required: true, options: ["コーチング", "コーチング以外"] },
];

const WORK_REPORT_COACHING_FIELDS: TaskFieldSpec[] = [
  ...WORK_REPORT_COMMON_FIELDS,
  { title: "生徒コード", kind: "text", required: true },
  { title: "生徒氏名(漢字フルネーム)", kind: "text", required: true },
  {
    title: "コーチングの参加状況",
    kind: "radio",
    required: true,
    options: ["当日参加", "当日キャンセル", "別週に振替予定", "振替実施", "初回コーチング（入塾後の運営面談）"],
  },
  {
    title: "今日の振り返り",
    kind: "checkbox",
    required: true,
    options: ["コーチング通知botへ今日の面談を実施する連絡をしましたか？"],
  },
];

const WORK_REPORT_NON_COACHING_FIELDS: TaskFieldSpec[] = [
  ...WORK_REPORT_COMMON_FIELDS,
  { title: "コーチング以外の作業時間(時間:分)", kind: "duration", required: true },
  {
    title: "作業内容",
    kind: "radio",
    required: true,
    options: [
      "(生徒引き受け時)引き継ぎカルテ作成",
      "(毎週)引き継ぎカルテ作成",
      "研修/研修動画視聴",
      "運営との面談",
      "質問対応",
      "ブログ作成",
      "テスト作成プロジェクト",
      "Instagram作成",
      "初回コーチング動画視聴",
      "その他",
    ],
  },
  { title: "具体的な作業内容", kind: "textarea", required: true },
  {
    title: "業務依頼者",
    kind: "radio",
    required: true,
    options: ["研修", "桃井 啓匠", "齋藤 優真", "小倉 瑠海", "鶴島 佑稀"],
  },
];

const SCHEDULE_CHANGE_FIELDS: TaskFieldSpec[] = [
  { title: "メールアドレス", kind: "text", required: true },
  { title: "お名前", kind: "dropdown", required: true },
  {
    title: "コーチング日程を変更する生徒さんのお名前を漢字で記入してください。\n※名字と名前の間に半角スペースを入れてください",
    kind: "text",
    required: true,
  },
  { title: "調整前(通常時)のコーチング時間を教えてください。", kind: "dateTime", required: true },
  { title: "変更後のコーチング時間を教えてください。", kind: "dateTime", required: true },
  {
    title: "コーチングの日程変更理由を教えてください。",
    kind: "radio",
    required: true,
    options: ["生徒都合", "(コーチが)体調不良", "予定が入ってしまった", "電車遅延/授業の延長など", "その他"],
  },
  { title: "【予定が入ってしまったを選んだ方への質問です】\n予定を教えてください。", kind: "textarea", required: false },
  { title: "【代行を依頼する場合】\n代行をしてくださるコーチのお名前をご記入ください。", kind: "text", required: false },
];

const HANDOFF_BASE_FIELDS: TaskFieldSpec[] = [
  { title: "メールアドレス", kind: "text", required: true },
  { title: "お名前_漢字フルネーム", kind: "dropdown", required: true },
  { title: "コーチコード", kind: "text", required: true },
  { title: "生徒氏名(漢字フルネーム)", kind: "text", required: true },
  { title: "生徒コード", kind: "text", required: true },
  {
    title: "引き継ぎ項目",
    kind: "radio",
    required: true,
    options: ["アドバンス/プレミアムコース（週2,3回）", "コーチ変更引き継ぎ", "代行引き継ぎ"],
  },
];

export function handoffTextareaTitle(policy: HandoffPolicy): string {
  if (policy === "advance_premium") {
    return "アドバンス/プレミアムコース_引き継ぎ内容";
  }
  if (policy === "coach_change") {
    return "コーチ変更_引き継ぎ内容";
  }
  return "代行_引き継ぎ内容";
}

export function handoffFieldSpecs(policy: HandoffPolicy): TaskFieldSpec[] {
  return [
    ...HANDOFF_BASE_FIELDS,
    { title: handoffTextareaTitle(policy), kind: "textarea", required: true },
  ];
}

export const FORM_CATALOG: Record<GreenfieldFormType, {
  formKey: "work_report" | "schedule_change" | "handoff";
  formLabel: string;
  viewUrl: string;
  fieldSpecs: TaskFieldSpec[];
}> = {
  work_report_coaching: {
    formKey: "work_report",
    formLabel: "作業時間報告-2025年度",
    viewUrl: FORM_URLS.work_report,
    fieldSpecs: WORK_REPORT_COACHING_FIELDS,
  },
  work_report_non_coaching: {
    formKey: "work_report",
    formLabel: "作業時間報告-2025年度",
    viewUrl: FORM_URLS.work_report,
    fieldSpecs: WORK_REPORT_NON_COACHING_FIELDS,
  },
  schedule_change: {
    formKey: "schedule_change",
    formLabel: "コーチング日程変更フォーム",
    viewUrl: FORM_URLS.schedule_change,
    fieldSpecs: SCHEDULE_CHANGE_FIELDS,
  },
  handoff: {
    formKey: "handoff",
    formLabel: "引き継ぎフォーム",
    viewUrl: FORM_URLS.handoff,
    fieldSpecs: handoffFieldSpecs("substitute"),
  },
};

export function requiredMissingFields(fieldSpecs: TaskFieldSpec[], answers: Record<string, AnswerValue>): string[] {
  return fieldSpecs
    .filter((field) => field.required)
    .filter((field) => {
      const value = answers[field.title];
      if (typeof value === "string") {
        return !value.trim();
      }
      if (Array.isArray(value)) {
        return value.length === 0;
      }
      if (value && typeof value === "object") {
        return !value.date || !(field.kind === "date" ? value.date : value.time);
      }
      return true;
    })
    .map((field) => field.title);
}
