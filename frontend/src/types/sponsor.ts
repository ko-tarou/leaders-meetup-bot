// sponsor_application: HackIT スポンサー募集の型 (BE migration 0064 準拠)。

export type SponsorStatus =
  | "unconfirmed" // メール確認待ち (公開 POST 直後)
  | "pending" // 確認済・運営対応待ち
  | "approved" // 協賛確定
  | "rejected"; // 見送り

export type SponsorApplication = {
  id: string;
  eventId: string;
  companyName: string;
  contactName: string;
  email: string;
  amount: number;
  period: string | null;
  purpose: string | null;
  status: SponsorStatus;
  decisionNote: string | null;
  confirmToken: string | null;
  confirmedAt: string | null;
  appliedAt: string;
  decidedAt: string | null;
};
