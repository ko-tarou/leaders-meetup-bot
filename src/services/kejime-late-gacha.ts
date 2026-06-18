// 朝勉強会けじめ制度: 遅刻ポイントの「ガチャ化」。
// 遅刻認定時に固定 +1pt ではなく 1〜3pt をサーバー側で抽選する。
// 抽選確率は kejime_tracker.config.latePointWeights で admin が変更できる。
// クライアントは結果に介入できない (抽選は processLateJudgment 内 = サーバー)。

export type LatePointWeights = {
  /** 1pt が出る確率 (%) */
  p1: number;
  /** 2pt が出る確率 (%) */
  p2: number;
  /** 3pt が出る確率 (%) */
  p3: number;
};

/** 仕様のデフォルト確率: 1pt=70% / 2pt=25% / 3pt=5%。合計 100。 */
export const DEFAULT_LATE_POINT_WEIGHTS: LatePointWeights = { p1: 70, p2: 25, p3: 5 };

/** ペナルティ記事の「1pt あたりの必要文字数」。1pt=500字 / 2pt=1000字 / 3pt=1500字。 */
export const DEFAULT_CHARS_PER_POINT = 500;

export type WeightsValidation =
  | { ok: true; weights: LatePointWeights }
  | { ok: false; reason: "not_object" | "not_integer" | "negative" | "sum_not_100" };

/**
 * pure: 任意の入力を LatePointWeights として検証する。
 * - 各値は 0 以上の整数であること
 * - 合計がちょうど 100 であること
 * admin フォーム保存時と config 読込時の双方でこの 1 か所を使う (DRY)。
 */
export function validateLatePointWeights(raw: unknown): WeightsValidation {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "not_object" };
  const o = raw as Record<string, unknown>;
  const vals = [o.p1, o.p2, o.p3];
  for (const v of vals) {
    if (typeof v !== "number" || !Number.isFinite(v)) return { ok: false, reason: "not_integer" };
    if (!Number.isInteger(v)) return { ok: false, reason: "not_integer" };
    if (v < 0) return { ok: false, reason: "negative" };
  }
  const p1 = o.p1 as number, p2 = o.p2 as number, p3 = o.p3 as number;
  if (p1 + p2 + p3 !== 100) return { ok: false, reason: "sum_not_100" };
  return { ok: true, weights: { p1, p2, p3 } };
}

/**
 * config から latePointWeights を取り出す。未設定 / 不正なら DEFAULT に
 * フォールバックする (既存挙動 = 実質固定確率にならないよう、検証を通った時のみ採用)。
 */
export function parseLatePointWeights(raw: unknown): LatePointWeights {
  const v = validateLatePointWeights(raw);
  return v.ok ? v.weights : DEFAULT_LATE_POINT_WEIGHTS;
}

/**
 * pure: [0,1) の乱数 r を受け取り、weights に従って 1 / 2 / 3 を返す。
 * r を注入可能にすることで抽選結果をテストで固定できる (副作用なし)。
 * 合計が 100 でない weights が万一来ても、累積しきい値で安全に丸める
 * (最後は 3pt に倒す = ペナルティ側に倒して甘くしない)。
 */
export function drawLatePoints(weights: LatePointWeights, r: number): 1 | 2 | 3 {
  const total = weights.p1 + weights.p2 + weights.p3;
  // total が 0 のときは固定 1pt (ゼロ除算回避・既存挙動に最も近い安全側)。
  if (total <= 0) return 1;
  const x = Math.min(Math.max(r, 0), 0.999999) * total;
  if (x < weights.p1) return 1;
  if (x < weights.p1 + weights.p2) return 2;
  return 3;
}

/** サーバー側抽選のエントリポイント。crypto 由来の乱数で 1〜3pt を返す。 */
export function rollLatePoints(weights: LatePointWeights): 1 | 2 | 3 {
  // crypto.getRandomValues で [0,1) を作る (Math.random より改ざん耐性の意図を明示)。
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  const r = buf[0] / 2 ** 32;
  return drawLatePoints(weights, r);
}

/** pure: ペナルティ記事に必要な文字数 = points × charsPerPoint。 */
export function requiredArticleLength(points: number, charsPerPoint: number): number {
  const p = Math.max(0, Math.floor(points));
  const c = charsPerPoint > 0 ? Math.floor(charsPerPoint) : DEFAULT_CHARS_PER_POINT;
  return p * c;
}
