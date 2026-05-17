/**
 * DevHub Ops 大規模リファクタ Phase 2-C: PR-Review context の pure domain。
 *
 * `src/services/sticky-pr-review-board.ts` にあった **純粋な判断/計算ロジック**
 * （LGTM しきい値の config 解釈・しきい値到達判定、副作用ゼロ）をそのまま
 * 切り出したもの。Phase 2-A (`domain/participation/submission.ts`) /
 * Phase 2-B (`domain/role/role-assign.ts`) で確立した「pure domain 抽出
 * パターン」を PR-Review context へ横展開する。
 *
 * 重要な不変条件（振る舞い不変の根拠）:
 * - 各関数は現状 service のコードを **式・短絡順・戻り値を変えず** に移植
 *   したものであり、結果は現状と byte-identical（characterization
 *   pr-review/* 93 件が無改変で green であることが機械的証明）。
 * - domain は純粋関数のみ。env / db / fetch / Slack / 時刻取得など I/O を
 *   一切持たない。DB read（resolveLgtmThreshold の review→event→config 解決）・
 *   Slack 送信・二重 repost/通知防止・トランザクション境界・fail-soft
 *   境界・呼び出し順序は service / route 側に残し一切変えない。
 * - service は後方互換のため domain から re-export する（既存 import
 *   パス・テストを無改変のまま維持する）。
 */

/**
 * Sprint 17 PR1: 自動完了に必要な LGTM 数の既定値。
 *
 * このしきい値に達した時点で sticky bot が status='merged' に自動更新する。
 * 現状 `src/services/sticky-pr-review-board.ts` の `LGTM_THRESHOLD` 定数
 * （値 2）と完全一致。service 側は後方互換のためここから re-export する。
 */
export const LGTM_THRESHOLD = 2;

/**
 * pr_review_list アクションの config から LGTM 自動完了しきい値を読む。
 *
 * - `config.lgtmThreshold` が 1 以上の整数なら採用
 * - 未設定 / 不正値 (0 以下・小数・非数値・不正 JSON) は LGTM_THRESHOLD (=2) に
 *   fallback（後方互換: 既存 config に lgtmThreshold が無ければ従来どおり 2）
 *
 * 現状 service の `readLgtmThreshold` と式・順序・戻り値が完全等価
 * （I/O なし。actionConfig の文字列は呼び出し側が DB から読んで渡す）。
 */
export function readLgtmThreshold(actionConfig: string | null): number {
  if (!actionConfig) return LGTM_THRESHOLD;
  try {
    const parsed = JSON.parse(actionConfig) as { lgtmThreshold?: unknown };
    const v = parsed.lgtmThreshold;
    if (typeof v === "number" && Number.isInteger(v) && v >= 1) return v;
    return LGTM_THRESHOLD;
  } catch {
    return LGTM_THRESHOLD;
  }
}
