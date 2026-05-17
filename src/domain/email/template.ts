/**
 * DevHub Ops 大規模リファクタ Phase 2-E: Email/通知テンプレの pure domain。
 *
 * `src/services/application-notification.ts` にあった **純粋な placeholder
 * 置換ロジック**（副作用ゼロ）をそのまま切り出したもの。Phase 2-A
 * (`domain/participation/submission.ts`) 〜 Phase 2-D
 * (`domain/schedule/candidate-dates.ts`) で確立した「pure domain 抽出
 * パターン」を Email context へ横展開する第 1 ファイル。
 *
 * `renderTemplate` は application-notification / participation-notification /
 * application-email の 3 service が共有するため domain/email に置き、
 * 各 service は後方互換のため re-export する（既存 import パス
 * `from "../services/application-notification"`・characterization テストを
 * 無改変のまま維持する＝振る舞い不変の機械的証明）。
 *
 * 重要な不変条件（振る舞い不変の根拠）:
 * - 正規表現・置換ロジック・未定義 key の扱い（`{unknown}` をそのまま
 *   残す）を **式・順序・イディオムを変えず** に移植した。結果は現状と
 *   byte-identical（characterization の番人テストが無改変 green で機械的
 *   に証明する）。
 * - domain は純粋関数のみ。env / db / fetch / Slack / 時刻取得など I/O を
 *   一切持たない。共通化の本格統合は Phase3。ここは pure 移設のみで
 *   振る舞いは一切変えない。
 */

/**
 * `{key}` 形式の placeholder を vars[key] で置換する。
 * 未定義 key はそのまま残す ({unknown} → {unknown})。
 */
export function renderTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (m, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : m,
  );
}
