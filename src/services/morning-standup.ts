import { drizzle } from "drizzle-orm/d1";
import { and, eq, sql } from "drizzle-orm";
import { eventActions, morningAttendance, scheduledJobs } from "../db/schema";
import type { SlackClient } from "./slack-api";
import { getJstNow } from "./time-utils";
import { plainText, mrkdwnSection } from "../domain/slack-blocks/builders";

// 003 朝勉強会けじめ制度 PR2: 平日 7:30 リマインダー + 8:00 締切投稿。
// weekly-reminder.ts と同じ scheduledJobs.dedupKey UNIQUE + 5 分窓パターン。
// config: { schemaVersion, channelId, roleId?, themes: { mon..fri: string } }。
// 土日 / channelId 未設定 / 窓外は skip。

type Block = Record<string, unknown>;
type Phase = "reminder" | "close";
type ThemeKey = "mon" | "tue" | "wed" | "thu" | "fri";
type Themes = Record<ThemeKey, string>;
type Config = { channelId: string; themes: Themes };

const DOW_KEYS: Record<number, ThemeKey | null> = {
  0: null, 1: "mon", 2: "tue", 3: "wed", 4: "thu", 5: "fri", 6: null };
const DOW_LABEL: Record<ThemeKey, string> = {
  mon: "月曜日", tue: "火曜日", wed: "水曜日", thu: "木曜日", fri: "金曜日" };
const DEFAULT_THEMES: Themes = {
  mon: "ハードウェア", tue: "フロントエンド", wed: "バックエンド", thu: "Android", fri: "Unity" };

export async function processMorningStandup(
  db: D1Database, slackClient: SlackClient,
): Promise<{ fired: number }> {
  const d1 = drizzle(db);
  const now = getJstNow();
  const themeKey = DOW_KEYS[new Date(Date.now() + 9 * 3600 * 1000).getUTCDay()];
  if (!themeKey) return { fired: 0 };
  const phase = phaseFor(now.hour, now.minute);
  if (!phase) return { fired: 0 };

  const ymdCompact = now.ymd.replace(/-/g, "");
  const actions = await d1.select().from(eventActions)
    .where(and(eq(eventActions.actionType, "morning_standup"), eq(eventActions.enabled, 1)))
    .all();

  let fired = 0;
  for (const a of actions) {
    const cfg = parseConfig(a.config);
    if (!cfg) { console.warn(`morning_standup: action ${a.id} invalid config; skip`); continue; }
    try {
      if (await fireOnce(db, slackClient, a.id, ymdCompact, now.ymd, phase,
                         cfg.channelId, cfg.themes[themeKey], themeKey)) fired++;
    } catch (e) {
      console.error(`morning_standup fireOnce error (action=${a.id}):`, e);
    }
  }
  return { fired };
}

function phaseFor(h: number, m: number): Phase | null {
  const cur = h * 60 + m;
  // 7:30=450, 8:00=480。5 分窓 (window = [t, t+5))。
  if (cur >= 450 && cur < 455) return "reminder";
  if (cur >= 480 && cur < 485) return "close";
  return null;
}

function parseConfig(raw: string | null | undefined): Config | null {
  if (!raw) return null;
  let p: unknown;
  try { p = JSON.parse(raw); } catch { return null; }
  if (!p || typeof p !== "object") return null;
  const o = p as { channelId?: unknown; themes?: unknown };
  if (typeof o.channelId !== "string" || !o.channelId.trim()) return null;
  const t = o.themes && typeof o.themes === "object" ? (o.themes as Record<string, unknown>) : {};
  const pick = (k: ThemeKey) =>
    typeof t[k] === "string" && (t[k] as string).trim() ? (t[k] as string) : DEFAULT_THEMES[k];
  return {
    channelId: o.channelId,
    themes: { mon: pick("mon"), tue: pick("tue"), wed: pick("wed"), thu: pick("thu"), fri: pick("fri") },
  };
}

function reminderBlocks(theme: string, tk: ThemeKey, aid: string, ymdC: string, ymd: string): Block[] {
  return [
    mrkdwnSection(
      `:books: *おはようございます！今日も朝活会あります*\n` +
      `今日のテーマ: *${theme}* (${DOW_LABEL[tk]})\n集合: 8:00 JST / ${ymd}`,
    ),
    { type: "actions", elements: [{
      type: "button", text: plainText("参加"),
      action_id: `morning_attend:${aid}:${ymdC}`,
      value: `${aid}:${ymdC}`, style: "primary",
    }] },
  ];
}

async function fireOnce(
  db: D1Database, slackClient: SlackClient, actionId: string,
  ymdCompact: string, ymd: string, phase: Phase,
  channelId: string, theme: string, themeKey: ThemeKey,
): Promise<boolean> {
  const dedupKey = `morning_standup:${actionId}:${ymdCompact}:${phase}`;
  const d1 = drizzle(db);
  if (!(await reservePending(d1, dedupKey, actionId, phase))) return false;

  let text: string;
  let blocks: Block[];
  if (phase === "reminder") {
    text = `今日の朝活: ${theme}`;
    blocks = reminderBlocks(theme, themeKey, actionId, ymdCompact, ymd);
  } else {
    const rows = await d1.select().from(morningAttendance)
      .where(and(eq(morningAttendance.eventActionId, actionId), eq(morningAttendance.date, ymd))).all();
    const count = rows.filter((r) => r.status === "attended").length;
    text = `朝活、締め切りです (${ymd})`;
    blocks = [mrkdwnSection(
      `:alarm_clock: *朝活、締め切りです* (${ymd})\n本日の出席登録: *${count}名*`,
    )];
  }

  try {
    await slackClient.postMessage(channelId, text, blocks);
    await d1.update(scheduledJobs).set({ status: "completed" })
      .where(eq(scheduledJobs.dedupKey, dedupKey));
    return true;
  } catch (e) {
    await d1.update(scheduledJobs).set({
      status: "failed",
      attempts: sql`${scheduledJobs.attempts} + 1`,
      lastError: String(e).slice(0, 500),
      failedAt: new Date().toISOString(),
    }).where(eq(scheduledJobs.dedupKey, dedupKey));
    console.error(`Failed to post morning_standup (action=${actionId}):`, e);
    return false;
  }
}

async function reservePending(
  d1: ReturnType<typeof drizzle>, dedupKey: string, actionId: string, phase: Phase,
): Promise<boolean> {
  const nowIso = new Date().toISOString();
  try {
    await d1.insert(scheduledJobs).values({
      id: crypto.randomUUID(), type: "morning_standup_sent", referenceId: actionId,
      nextRunAt: nowIso, status: "pending",
      payload: JSON.stringify({ phase }), dedupKey, createdAt: nowIso,
    });
    return true;
  } catch (e) {
    // UNIQUE 違反 = 既に他 worker / 完了済み → skip (非 UNIQUE のみログ)。
    const msg = String(e);
    if (!msg.includes("UNIQUE") && !msg.includes("constraint")) {
      console.error("Failed to reserve morning_standup dedup row:", e);
    }
    return false;
  }
}

// 参加ボタン押下: morning_attendance に attended INSERT。UNIQUE 違反 = 重複押下扱い。
export async function handleMorningAttend(
  db: D1Database,
  args: { eventActionId: string; ymdCompact: string; slackUserId: string; messageTs?: string | null },
): Promise<{ text: string }> {
  const { eventActionId, ymdCompact, slackUserId, messageTs } = args;
  if (!/^\d{8}$/.test(ymdCompact)) return { text: ":warning: ボタンの形式が不正です。" };
  const date = `${ymdCompact.slice(0, 4)}-${ymdCompact.slice(4, 6)}-${ymdCompact.slice(6, 8)}`;
  const d1 = drizzle(db);

  // テーマは ephemeral 応答に添える任意フィールド。土日や config 不明時は空。
  const action = await d1.select().from(eventActions).where(eq(eventActions.id, eventActionId)).get();
  const cfg = parseConfig(action?.config ?? null);
  const tk = DOW_KEYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
  const theme = cfg && tk ? cfg.themes[tk] : "";

  try {
    await d1.insert(morningAttendance).values({
      id: crypto.randomUUID(), eventActionId, date, slackUserId,
      status: "attended", messageTs: messageTs ?? null,
      recordedAt: new Date().toISOString(),
    });
    return { text: `:white_check_mark: 参加を記録しました${theme ? ` (${theme} がんばりましょう)` : ""}` };
  } catch (e) {
    if (isUniqueViolation(e)) return { text: ":information_source: 既に記録済みです" };
    console.error("morning_attend insert error:", e);
    return { text: ":warning: 記録に失敗しました。少し後で再試行してください。" };
  }
}

// drizzle-orm が D1 エラーを wrap するため cause chain で UNIQUE を検知する。
function isUniqueViolation(e: unknown): boolean {
  let cur: unknown = e;
  while (cur instanceof Error) {
    if (cur.message.includes("UNIQUE") || cur.message.includes("constraint failed")) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
