/**
 * DevHub Ops 大規模リファクタ Phase 2-D: Scheduler context の pure domain。
 *
 * `src/services/auto-cycle.ts` にあった **純粋な計算/判断ロジック**
 * （candidate_rule の正規化・候補日生成・poll 開始/締切判定、副作用ゼロ）を
 * そのまま切り出したもの。Phase 2-A (`domain/participation/submission.ts`) /
 * Phase 2-B (`domain/role/role-assign.ts`) / Phase 2-C
 * (`domain/pr-review/lgtm.ts`) で確立した「pure domain 抽出パターン」を
 * Scheduler context へ横展開する。
 *
 * 重要な不変条件（振る舞い不変の根拠）:
 * - 各関数は現状 service のコードを **式・短絡順・戻り値・イディオムを
 *   変えず** に移植したものであり、結果は現状と byte-identical
 *   （characterization schedule/* 100 件が無改変で green であることが
 *   機械的証明）。candidate 生成の Date 演算・UTC 起点計算・第N週判定・
 *   monthOffset・重複除去ソート・fire 窓 (9分)・legacy weekday 後方互換は
 *   一切変えていない。
 * - domain は純粋関数のみ。env / db / fetch / Slack / 時刻取得 (getJstNow)
 *   など I/O を一切持たない。DB read・poll 作成/締切・集計・冪等
 *   (dedupKey)・トランザクション境界・fail-soft 境界・呼び出し順序は
 *   service / route 側に残し一切変えない。`JstNow` は呼び出し側
 *   (auto-cycle.ts) が `getJstNow()` で取得した値を引数で渡す。
 * - service は後方互換のため domain から re-export する（既存 import
 *   パス `from "../services/auto-cycle"`・characterization テストを
 *   無改変のまま維持する）。
 */
import { getJstNow } from "../../services/time-utils";

export type Frequency = "daily" | "weekly" | "monthly" | "yearly";

// candidate_rule は frequency 別に shape が変わる。
// 既存(legacy) monthly row は { type:"weekday", weekday, weeks, monthOffset } で保存されている。
// 新形は weekdays(配列) を持つ。weekdays があればそれを優先し、無ければ legacy weekday を
// 単一要素配列として扱う（normalizeWeekdays で吸収）。migration 不要。
export type MonthlyRule = {
  type: "weekday";
  weekdays?: number[]; // 新形: 0=日, 1=月, ..., 6=土 の配列 (1〜7要素)
  weekday?: number; // legacy: 単一曜日 (後方互換用)
  weeks: number[];
  monthOffset?: number;
};

/**
 * monthly weekday rule の曜日を正規化して number[] に揃える。
 * 新形 weekdays があればそれを、無ければ legacy weekday を [weekday] として扱う。
 * 0-6 範囲外を除去し、重複除去・昇順ソートする。
 */
export function normalizeWeekdays(rule: MonthlyRule): number[] {
  const raw =
    rule.weekdays && rule.weekdays.length > 0
      ? rule.weekdays
      : typeof rule.weekday === "number"
        ? [rule.weekday]
        : [];
  const filtered = raw.filter(
    (w) => typeof w === "number" && Number.isInteger(w) && w >= 0 && w <= 6,
  );
  return Array.from(new Set(filtered)).sort((a, b) => a - b);
}
export type WeeklyRule = { type?: "weekly"; weekday: number; weeksAhead?: number };
export type YearlyRule = { type?: "yearly"; month: number; day: number };
export type DailyRule = { type?: "daily" };
export type CandidateRule = MonthlyRule | WeeklyRule | YearlyRule | DailyRule;

export type ScheduleRow = {
  id: string;
  meetingId: string;
  frequency: string;
  candidateRule: string;
  pollStartDay: number;
  pollStartTime: string;
  pollCloseDay: number;
  pollCloseTime: string;
  pollStartWeekday: number | null;
  pollCloseWeekday: number | null;
  pollStartMonth: number | null;
  pollCloseMonth: number | null;
  reminderTime: string;
  messageTemplate: string | null;
  reminderMessageTemplate: string | null;
  reminders: string;
  enabled: number;
  createdAt: string;
};

export function asFrequency(v: string): Frequency {
  switch (v) {
    case "daily":
    case "weekly":
    case "yearly":
      return v;
    case "monthly":
    default:
      return "monthly";
  }
}

/**
 * cron は 5 分粒度。time 判定は「fire 時刻以降の 9 分窓」とすることで、
 * 5 分毎の cron が確実に 1 回ヒットするようにする。
 */
function isWithinFireWindow(currentHM: string, targetHM: string): boolean {
  const [ch, cm] = currentHM.split(":").map(Number);
  const [th, tm] = targetHM.split(":").map(Number);
  if ([ch, cm, th, tm].some((n) => Number.isNaN(n))) return false;
  const cMins = ch * 60 + cm;
  const tMins = th * 60 + tm;
  return cMins >= tMins && cMins < tMins + 9;
}

export type JstNow = ReturnType<typeof getJstNow>;

/**
 * frequency 別に「今 cron で poll を start すべきか」を判定する純粋関数。
 */
export function shouldStartPoll(now: JstNow, schedule: ScheduleRow): boolean {
  if (!isWithinFireWindow(now.hm, schedule.pollStartTime)) return false;
  const freq = asFrequency(schedule.frequency);
  switch (freq) {
    case "daily":
      return true;
    case "weekly": {
      if (schedule.pollStartWeekday == null) return false;
      // JST の曜日: ymd を元に Date を作って getDay
      const wd = new Date(`${now.ymd}T00:00:00Z`).getUTCDay();
      return wd === schedule.pollStartWeekday;
    }
    case "monthly":
      return now.day === schedule.pollStartDay;
    case "yearly":
      return (
        now.day === schedule.pollStartDay &&
        schedule.pollStartMonth != null &&
        now.month === schedule.pollStartMonth
      );
  }
}

/** frequency 別に「今 cron で poll を close すべきか」を判定する純粋関数。 */
export function shouldClosePoll(now: JstNow, schedule: ScheduleRow): boolean {
  if (!isWithinFireWindow(now.hm, schedule.pollCloseTime)) return false;
  const freq = asFrequency(schedule.frequency);
  switch (freq) {
    case "daily":
      return true;
    case "weekly": {
      if (schedule.pollCloseWeekday == null) return false;
      const wd = new Date(`${now.ymd}T00:00:00Z`).getUTCDay();
      return wd === schedule.pollCloseWeekday;
    }
    case "monthly":
      return now.day === schedule.pollCloseDay;
    case "yearly":
      return (
        now.day === schedule.pollCloseDay &&
        schedule.pollCloseMonth != null &&
        now.month === schedule.pollCloseMonth
      );
  }
}

/**
 * monthly: candidateRule (type:"weekday") に基づいて候補日を生成する（純粋関数）。
 * weeks[] × weekdays[] の全組合せ（第N週の各曜日）を生成し、重複除去・昇順ソートする。
 * legacy 単一 weekday は normalizeWeekdays が [weekday] に正規化するため挙動不変。
 */
export function generateCandidateDates(rule: MonthlyRule, yearMonth: string): string[] {
  const [year, month] = yearMonth.split("-").map(Number);
  const weekdays = normalizeWeekdays(rule);
  if (weekdays.length === 0) return [];
  const dateSet = new Set<string>();
  const daysInMonth = new Date(year, month, 0).getDate();

  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(year, month - 1, day);
    if (!weekdays.includes(date.getDay())) continue;

    const weekNumber = Math.ceil(day / 7);
    if (rule.weeks.includes(weekNumber)) {
      const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      dateSet.add(dateStr);
    }
  }

  return Array.from(dateSet).sort();
}

/** baseYearMonth ("YYYY-MM") に offset ヶ月を加算した YYYY-MM を返す */
function applyMonthOffset(baseYearMonth: string, offset: number): string {
  const [year, month] = baseYearMonth.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1 + offset, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** monthly: rule.monthOffset を考慮して候補日を生成する */
export function generateCandidateDatesWithOffset(
  rule: MonthlyRule,
  baseYearMonth: string,
): string[] {
  const offset = rule.monthOffset ?? 0;
  const targetYearMonth = applyMonthOffset(baseYearMonth, offset);
  return generateCandidateDates(rule, targetYearMonth);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** JST の (now) を起点に、指定した曜日の次に来る日付 (YYYY-MM-DD) を返す。weeksAhead 週後ろにシフト可。 */
function computeNextWeekday(jst: JstNow, weekday: number, weeksAhead = 0): string {
  const base = new Date(`${jst.ymd}T00:00:00Z`);
  const cur = base.getUTCDay();
  let diff = (weekday - cur + 7) % 7;
  if (diff === 0) diff = 7; // 同曜日なら次週
  diff += weeksAhead * 7;
  base.setUTCDate(base.getUTCDate() + diff);
  return `${base.getUTCFullYear()}-${pad2(base.getUTCMonth() + 1)}-${pad2(base.getUTCDate())}`;
}

/**
 * frequency 別に候補日を生成する。
 *  - daily:   翌日 (今日が投票日と被らないように)
 *  - weekly:  次に来る指定曜日 (weeksAhead 適用)
 *  - monthly: 既存ロジック (monthOffset 適用)
 *  - yearly:  翌年の (month, day)
 */
export function generateCandidateDatesForFrequency(
  frequency: Frequency,
  rule: CandidateRule,
  jst: JstNow,
): string[] {
  switch (frequency) {
    case "daily": {
      const d = new Date(`${jst.ymd}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1);
      return [
        `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`,
      ];
    }
    case "weekly": {
      const r = rule as WeeklyRule;
      if (typeof r.weekday !== "number") return [];
      return [computeNextWeekday(jst, r.weekday, r.weeksAhead ?? 0)];
    }
    case "monthly":
      return generateCandidateDatesWithOffset(rule as MonthlyRule, jst.ym);
    case "yearly": {
      const r = rule as YearlyRule;
      if (typeof r.month !== "number" || typeof r.day !== "number") return [];
      // 来年の (month, day) を候補日として返す
      const targetYear = jst.year + 1;
      return [`${targetYear}-${pad2(r.month)}-${pad2(r.day)}`];
    }
  }
}
