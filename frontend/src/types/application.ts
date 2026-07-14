// 応募 (ADR-0008 / Sprint 16)
export type ApplicationStatus =
  | "pending"
  | "scheduled"
  | "passed"
  | "failed"
  | "rejected";

// Sprint 19 PR2: Google Form 「DevelopersHub 面談フォーム」準拠の選択肢
export type HowFound =
  | "joint_briefing"
  | "welcome_event"
  | "poster"
  | "campus_hp"
  | "friend"
  | "teacher"
  | "other";

export type InterviewLocation = "online" | "lab206";

export const HOW_FOUND_LABEL: Record<HowFound, string> = {
  joint_briefing: "情報系プロジェクト合同説明会",
  welcome_event: "welcome紹介イベント",
  poster: "ポスター",
  campus_hp: "学内HP",
  friend: "友人",
  teacher: "先生",
  other: "その他",
};

export const INTERVIEW_LOCATION_LABEL: Record<InterviewLocation, string> = {
  online: "オンライン（Google Meet）",
  lab206: "11号館Lab206",
};

export type Application = {
  id: string;
  eventId: string;
  name: string;
  email: string;
  // Sprint 16 の旧フィールド（後方互換のため残置。Sprint 19 PR2 以降は新フォームから入らない）
  motivation: string | null;
  introduction: string | null;
  // Sprint 19 PR2: Google Form 準拠の新フィールド（既存レコードは null）
  // studentId=学籍番号(数字, 例 1400980), rosterNumber=名列番号(例 3EP2-26)
  studentId: string | null;
  rosterNumber: string | null;
  howFound: HowFound | null;
  interviewLocation: InterviewLocation | null;
  existingActivities: string | null;
  // UTC ISO 配列の JSON 文字列。フロントでパースして表示
  availableSlots: string;
  status: ApplicationStatus;
  interviewAt: string | null;
  decisionNote: string | null;
  appliedAt: string;
  decidedAt: string | null;
};
