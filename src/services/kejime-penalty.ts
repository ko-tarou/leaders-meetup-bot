// 朝勉強会けじめ制度: ペナルティを「遅刻 (欠席) イベント単位」で管理する純粋ロジック。
//
// 基盤 (PR#315) はガチャ抽選 (1-3pt) と「保有ポイント x 500字」スケールを実装した。
// 本モジュールはそれを「イベント単位」へ拡張する:
//   - 各遅刻イベント = { 日付, その日のテーマ, ガチャ付与pt } を 1 行の penalty として記録。
//   - 各ペナルティ = 記事 1 本・(pt x charsPerPoint) 文字・その日のテーマ準拠。
//   - 3pt 一括イベント = 1 本 (1500字) で消せる。1ptずつ別々のイベントは各イベントに 1 本ずつ。
//   - 別イベントを 1 本に合算して消すのは不可 (= penalty 単位でしかクリアできない)。
//
// I/O を持たない pure 関数だけをここに置き、DB/Slack 副作用は service 側に置く (テスタブル)。

import { DEFAULT_CHARS_PER_POINT, requiredArticleLength } from "./kejime-late-gacha";

export type PenaltyStatus = "open" | "cleared";

/** ペナルティ 1 件 (= 遅刻イベント 1 件) の要約。表示・集計に使う最小形。 */
export type PenaltySummary = {
  id: string;
  date: string; // YYYY-MM-DD (JST)
  theme: string; // その日のテーマ (snapshot)。空文字可。
  points: number; // ガチャ付与 pt (1-3)。
  requiredChars: number; // points x charsPerPoint (申請時点で凍結済み)。
  status: PenaltyStatus;
};

/**
 * pure: ある member の open ペナルティ群から「必要記事本数」「必要総文字数」を集計する。
 * - 必要記事数 = open ペナルティ件数 (1 ペナルティ = 1 本)。
 * - 必要総文字数 = 各 open ペナルティの requiredChars の総和 (参考表示用)。
 * これは「別イベントを 1 本に合算できない」仕様を本数=件数として明示する。
 */
export function summarizeOpenPenalties(
  penalties: PenaltySummary[],
): { articlesNeeded: number; totalCharsNeeded: number; points: number } {
  const open = penalties.filter((p) => p.status === "open");
  return {
    articlesNeeded: open.length,
    totalCharsNeeded: open.reduce((s, p) => s + Math.max(0, p.requiredChars), 0),
    points: open.reduce((s, p) => s + Math.max(0, p.points), 0),
  };
}

/**
 * pure: penalty 行に凍結する requiredChars を計算する。
 * points x charsPerPoint。charsPerPoint<=0 は DEFAULT(500) に丸める (基盤と同じ規約)。
 */
export function penaltyRequiredChars(points: number, charsPerPoint: number): number {
  return requiredArticleLength(points, charsPerPoint > 0 ? charsPerPoint : DEFAULT_CHARS_PER_POINT);
}

export type ArticleEligibility =
  | { ok: true }
  | { ok: false; reason: "too_short"; length: number; required: number }
  | { ok: false; reason: "penalty_not_open" }
  | { ok: false; reason: "theme_pending" }; // 文字数は満たすがテーマ承認待ち。

/**
 * pure: 提出記事が「このペナルティを自動でクリアしてよいか」を判定する。
 *
 * - penalty が open でなければ不可。
 * - 文字数が penalty.requiredChars 未満なら too_short。
 * - 文字数 OK でも、テーマ準拠はデフォルト「管理者の手動承認」が必要なので、
 *   requireThemeApproval=true のときは theme_pending を返す (自動クリアしない)。
 *   requireThemeApproval=false (= テーマ確認不要 / 既にテーマ承認済み) なら ok。
 *
 * 自動キーワードチェック等は呼び出し側が補助提案として使うが、本判定の必須条件には
 * 含めない (仕様: テーマ準拠の確認は管理者手動承認が基本線)。
 */
export function evaluateArticleForPenalty(args: {
  penaltyStatus: PenaltyStatus;
  bodyLength: number;
  requiredChars: number;
  requireThemeApproval: boolean;
}): ArticleEligibility {
  if (args.penaltyStatus !== "open") return { ok: false, reason: "penalty_not_open" };
  if (args.bodyLength < args.requiredChars) {
    return { ok: false, reason: "too_short", length: args.bodyLength, required: args.requiredChars };
  }
  if (args.requireThemeApproval) return { ok: false, reason: "theme_pending" };
  return { ok: true };
}

/**
 * pure: 補助的なテーマ自動チェック (キーワード一致)。
 * 仕様上は必須でなく「提案レベル」。theme の語が記事タイトル/本文に含まれるかの素朴判定。
 * theme が空文字なら判定不能として null を返す (admin 判断に委ねる)。
 */
export function suggestThemeMatch(theme: string, haystack: string): boolean | null {
  const t = theme.trim();
  if (!t) return null;
  return haystack.toLowerCase().includes(t.toLowerCase());
}
