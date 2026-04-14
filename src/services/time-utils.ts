/**
 * JST (日本時間) 用の時刻ヘルパー。
 *
 * Cloudflare Workers は UTC ランタイムなので、JST で考えたい日付・時刻は
 * ここでまとめて変換する。
 *
 * 方針:
 * - ユーザー入力・表示・比較は JST 基準
 * - scheduled_jobs.nextRunAt のみ UTC ISO で保存（lexicographic 比較のため）
 */

/**
 * 現在時刻の JST 日付・時刻を返す。
 * Date.now() に +9h してから UTC メソッドを叩くことで JST のカレンダー値を得る。
 */
export function getJstNow(): {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  second: number;
  hm: string; // "HH:MM"
  hms: string; // "HH:MM:SS"
  ym: string; // "YYYY-MM"
  ymd: string; // "YYYY-MM-DD"
} {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const day = now.getUTCDate();
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();
  const second = now.getUTCSeconds();
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    hm: `${pad(hour)}:${pad(minute)}`,
    hms: `${pad(hour)}:${pad(minute)}:${pad(second)}`,
    ym: `${year}-${pad(month)}`,
    ymd: `${year}-${pad(month)}-${pad(day)}`,
  };
}

/**
 * JST 日付文字列 "YYYY-MM-DD" と JST 時刻 "HH:MM" or "HH:MM:SS" を
 * UTC の ISO8601 文字列（Z 付き）に変換する。
 *
 * 例: jstToUtcIso("2026-04-23", "09:00") → "2026-04-23T00:00:00.000Z"
 */
export function jstToUtcIso(ymd: string, time: string): string {
  const normalized = /^\d{2}:\d{2}$/.test(time) ? `${time}:00` : time;
  const d = new Date(`${ymd}T${normalized}+09:00`);
  return d.toISOString();
}
