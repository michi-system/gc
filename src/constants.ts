import type { AppConfig, FormKey, FormType, TaskFieldSpec } from "./types.js";

export const APP_PORT = Number(process.env.PORT ?? "3131");
export const LOCAL_BASE_URL = `http://127.0.0.1:${APP_PORT}`;
export const DEFAULT_DB_PATH = ".local/app.db";
export const DEFAULT_TOKEN_PATH = ".local/oauth/tokens.json";
export const DEFAULT_GOOGLE_CREDENTIALS_PATH = ".local/oauth/client_secret.json";

export const FIXED_ROSTER_SPREADSHEET_ID = "1wfIBjJOzTe3j3PWsW_6PwFfwjjtjUsIdvdUQFw39Nsc";

export const FORM_URLS: Record<FormKey, string> = {
  work_report:
    "https://docs.google.com/forms/d/e/1FAIpQLScX1kcDYuuEp3rNVGqIWVYQT4r5nTLXiFmKm4Dpfar7BVMSgQ/viewform",
  schedule_change:
    "https://docs.google.com/forms/d/e/1FAIpQLSdCborRTdo0u9Oicusv2NHoP1lwR8uhqZCShLl2uzFaxmzxeQ/viewform",
  handoff:
    "https://docs.google.com/forms/d/e/1FAIpQLSek3Acb1pm-vYtr8vbr7fVdLGKq615X8wv7SyClSUVeLNi4mw/viewform",
};

export const FORM_TITLES: Record<FormKey, string> = {
  work_report: "作業時間報告-2025年度",
  schedule_change: "コーチング日程変更フォーム",
  handoff: "引き継ぎフォーム",
};

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

const HANDOFF_COMMON_FIELDS: TaskFieldSpec[] = [
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

export const FORM_CATALOG: Record<
  FormType,
  {
    formKey: FormKey;
    label: string;
    title: string;
    viewUrl: string;
    emailSearchTitle: string;
    fieldSpecs: TaskFieldSpec[];
  }
> = {
  work_report_coaching: {
    formKey: "work_report",
    label: "作業報告 / コーチング",
    title: FORM_TITLES.work_report,
    viewUrl: FORM_URLS.work_report,
    emailSearchTitle: FORM_TITLES.work_report,
    fieldSpecs: WORK_REPORT_COACHING_FIELDS,
  },
  work_report_non_coaching: {
    formKey: "work_report",
    label: "作業報告 / コーチング以外",
    title: FORM_TITLES.work_report,
    viewUrl: FORM_URLS.work_report,
    emailSearchTitle: FORM_TITLES.work_report,
    fieldSpecs: WORK_REPORT_NON_COACHING_FIELDS,
  },
  schedule_change: {
    formKey: "schedule_change",
    label: "日程変更",
    title: FORM_TITLES.schedule_change,
    viewUrl: FORM_URLS.schedule_change,
    emailSearchTitle: FORM_TITLES.schedule_change,
    fieldSpecs: SCHEDULE_CHANGE_FIELDS,
  },
  handoff: {
    formKey: "handoff",
    label: "引き継ぎ",
    title: FORM_TITLES.handoff,
    viewUrl: FORM_URLS.handoff,
    emailSearchTitle: FORM_TITLES.handoff,
    fieldSpecs: HANDOFF_COMMON_FIELDS,
  },
};

export const HANDOFF_BODY_TITLES = {
  advance_premium: "アドバンス/プレミアムコース_引き継ぎ内容",
  coach_change: "コーチ変更_引き継ぎ内容",
  substitute: "代行_引き継ぎ内容",
} as const;

export const HANDOFF_VALUE_BY_POLICY = {
  advance_premium: "アドバンス/プレミアムコース（週2,3回）",
  coach_change: "コーチ変更引き継ぎ",
  substitute: "代行引き継ぎ",
} as const;

export const DEFAULT_CONFIG: AppConfig = {
  timezone: "Asia/Tokyo",
  syncWindowDays: 21,
  coachProfile: {
    coachName: "預忠道",
    coachCode: "gco0491",
    email: "",
  },
  googleOAuth: {
    clientCredentialsPath: DEFAULT_GOOGLE_CREDENTIALS_PATH,
  },
  calendars: {
    selectedCalendarIds: [],
  },
  gmail: {
    queries: {
      work_report: `subject:"${FORM_TITLES.work_report}" newer_than:30d`,
      schedule_change: `subject:"${FORM_TITLES.schedule_change}" newer_than:30d`,
      handoff: `subject:"${FORM_TITLES.handoff}" newer_than:30d`,
    },
  },
  sheets: {
    spreadsheetId: FIXED_ROSTER_SPREADSHEET_ID,
    sheetName: "",
    headerRow: 1,
    studentNameColumn: "A",
    studentCodeColumn: "B",
  },
};
