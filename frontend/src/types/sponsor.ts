// sponsor_application: HackIT 個人スポンサー募集の型 (BE migration 0064 / 個人化 0065 準拠)。

export type SponsorStatus =
  | "unconfirmed" // メール確認待ち (公開 POST 直後)
  | "pending" // 確認済・運営対応待ち
  | "approved" // 協賛確定
  | "rejected"; // 見送り

export type SponsorApplication = {
  id: string;
  eventId: string;
  // companyName 列は個人化で「お名前(氏名)」格納先に再利用 (BE 0065)。
  companyName: string;
  // 後方互換で残置 (旧担当者名)。個人申込では氏名と同値。
  contactName: string;
  email: string;
  amount: number;
  // 所属 (任意・個人化 0065)。
  affiliation: string | null;
  // 応援メッセージ / コメント (任意・個人化 0065)。
  message: string | null;
  // 旧項目 (後方互換)。
  period: string | null;
  purpose: string | null;
  status: SponsorStatus;
  decisionNote: string | null;
  confirmToken: string | null;
  confirmedAt: string | null;
  appliedAt: string;
  decidedAt: string | null;
};
