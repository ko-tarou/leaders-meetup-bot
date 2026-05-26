import { drizzle } from "drizzle-orm/d1";
import { and, eq, sql } from "drizzle-orm";
import {
  eventActions, morningAttendance, scheduledJobs, slackRoleMembers,
} from "../db/schema";
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
type MessageTemplates = { reminder?: string; close?: string };
type Config = {
  channelId: string;
  // PR10: roleId は morning_standup.config に直接持つ optional 値。
  // 設定済みなら reminder 投稿時にロールメンバー全員へメンション (<@U..>) を打つ。
  // 空 / 未設定 / メンバー 0 件 → {mentions} は空文字に展開し従来挙動を維持。
  roleId?: string;
  themes: Themes;
  messageTemplates?: MessageTemplates;
  reminderTime: string; // "HH:MM" (5 分単位丸め済)
  closeTime: string; // "HH:MM" (5 分単位丸め済)
};

// 003 PR9: 投稿時刻 / 締切時刻のカスタマイズ対応。
// 既存挙動 (7:30 / 8:00 hardcode) を default として維持。
// cron は 5 分粒度なので保存値は 5 分単位に丸める。
export const DEFAULT_REMINDER_TIME = "07:30";
export const DEFAULT_CLOSE_TIME = "08:00";
// 5 分窓 (window = [t, t+5))。weekly-reminder と同じ思想 (cron 粒度に合わせる)。
const FIRE_WINDOW_MINUTES = 5;

const DOW_KEYS: Record<number, ThemeKey | null> = {
  0: null, 1: "mon", 2: "tue", 3: "wed", 4: "thu", 5: "fri", 6: null };
const DOW_LABEL: Record<ThemeKey, string> = {
  mon: "月曜日", tue: "火曜日", wed: "水曜日", thu: "木曜日", fri: "金曜日" };
const DEFAULT_THEMES: Themes = {
  mon: "ハードウェア", tue: "フロントエンド", wed: "バックエンド", thu: "Android", fri: "Unity" };

// 003 PR8: リマインド / 締切 文面のカスタマイズ対応。
// テンプレ未指定 (or 空文字) なら従来の hardcoded 文言が使われる。
// placeholder: {theme} {dayLabel} {date} {count} {mentions} (PR10)。
// {mentions} はロールメンバー全員へのメンション文字列 ("<@U1> <@U2>") に展開される。
// メンバー 0 件 or roleId 未設定なら空文字に展開し、先頭の改行も生まれないよう
// default template では先頭に置く (空 = 1 行目が消えるだけで済む)。
export const DEFAULT_REMINDER_TEMPLATE =
  "{mentions}\n:books: *おはようございます！今日も朝活会あります*\n" +
  "今日のテーマ: *{theme}* ({dayLabel})\n集合: 8:00 JST / {date}";
export const DEFAULT_CLOSE_TEMPLATE =
  ":alarm_clock: *朝活、締め切りです* ({date})\n本日の出席登録: *{count}名*";

export function renderTemplate(
  tpl: string,
  vars: {
    theme?: string; dayLabel?: string; date?: string;
    count?: number; mentions?: string;
  },
): string {
  // mentions が空文字 (roleId 未設定 / メンバー 0 件) で、かつ template の
  // 1 行目が "{mentions}" のみ (= default template の頭) のときは先頭の
  // 空行を抑える。文中の {mentions} はそのまま空文字置換 (副作用なし)。
  let body = tpl;
  const m = vars.mentions ?? "";
  if (!m && /^\{mentions\}\n/.test(body)) {
    body = body.replace(/^\{mentions\}\n/, "");
  }
  return body
    .replace(/\{mentions\}/g, m)
    .replace(/\{theme\}/g, vars.theme ?? "")
    .replace(/\{dayLabel\}/g, vars.dayLabel ?? "")
    .replace(/\{date\}/g, vars.date ?? "")
    .replace(/\{count\}/g, vars.count != null ? String(vars.count) : "");
}

export function buildReminderText(
  templates: MessageTemplates | undefined,
  vars: { theme: string; dayLabel: string; date: string; mentions?: string },
): string {
  const tpl =
    templates?.reminder && templates.reminder.trim()
      ? templates.reminder
      : DEFAULT_REMINDER_TEMPLATE;
  return renderTemplate(tpl, vars);
}

// PR10: slack user id 配列 → "<@U1> <@U2>" 形式の mention 文字列を組み立てる。
// 空配列は "" を返し、template 内 {mentions} は空文字置換される。
export function buildMentionString(slackUserIds: string[]): string {
  return slackUserIds.map((u) => `<@${u}>`).join(" ");
}

export function buildCloseText(
  templates: MessageTemplates | undefined,
  vars: { date: string; count: number },
): string {
  const tpl =
    templates?.close && templates.close.trim()
      ? templates.close
      : DEFAULT_CLOSE_TEMPLATE;
  return renderTemplate(tpl, vars);
}

export async function processMorningStandup(
  db: D1Database, slackClient: SlackClient,
): Promise<{ fired: number }> {
  const d1 = drizzle(db);
  const now = getJstNow();
  const themeKey = DOW_KEYS[new Date(Date.now() + 9 * 3600 * 1000).getUTCDay()];
  if (!themeKey) return { fired: 0 };

  const ymdCompact = now.ymd.replace(/-/g, "");
  const actions = await d1.select().from(eventActions)
    .where(and(eq(eventActions.actionType, "morning_standup"), eq(eventActions.enabled, 1)))
    .all();

  let fired = 0;
  for (const a of actions) {
    const cfg = parseConfig(a.config);
    if (!cfg) { console.warn(`morning_standup: action ${a.id} invalid config; skip`); continue; }
    // PR9: config の reminderTime / closeTime と現時刻を 5 分窓で比較。
    let phase: Phase | null = null;
    if (isWithinFireWindow(now.hour, now.minute, cfg.reminderTime)) phase = "reminder";
    else if (isWithinFireWindow(now.hour, now.minute, cfg.closeTime)) phase = "close";
    if (!phase) continue;
    try {
      if (await fireOnce(db, slackClient, a.id, ymdCompact, now.ymd, phase,
                         cfg.channelId, cfg.themes[themeKey], themeKey,
                         cfg.messageTemplates, cfg.roleId)) fired++;
    } catch (e) {
      console.error(`morning_standup fireOnce error (action=${a.id}):`, e);
    }
  }
  return { fired };
}

// 5 分窓判定 (weekly-reminder.ts と同じ思想)。配信時刻 [t, t+5) に
// 現時刻が含まれれば true。HH:MM が不正なら false。
export function isWithinFireWindow(
  nowHour: number, nowMinute: number, scheduled: string,
): boolean {
  const sched = parseHm(scheduled);
  if (sched == null) return false;
  const cur = nowHour * 60 + nowMinute;
  return cur >= sched && cur < sched + FIRE_WINDOW_MINUTES;
}

function parseHm(hm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

// 5 分単位への丸め (Math.floor)。HH:MM 形式以外は default を返す。
export function normalizeFireTime(hm: unknown, fallback: string): string {
  if (typeof hm !== "string") return fallback;
  const parsed = parseHm(hm);
  if (parsed == null) return fallback;
  const h = Math.floor(parsed / 60);
  const m = Math.floor((parsed % 60) / 5) * 5;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function parseConfig(raw: string | null | undefined): Config | null {
  if (!raw) return null;
  let p: unknown;
  try { p = JSON.parse(raw); } catch { return null; }
  if (!p || typeof p !== "object") return null;
  const o = p as {
    channelId?: unknown;
    roleId?: unknown;
    themes?: unknown;
    messageTemplates?: unknown;
    reminderTime?: unknown;
    closeTime?: unknown;
  };
  if (typeof o.channelId !== "string" || !o.channelId.trim()) return null;
  const t = o.themes && typeof o.themes === "object" ? (o.themes as Record<string, unknown>) : {};
  const pick = (k: ThemeKey) =>
    typeof t[k] === "string" && (t[k] as string).trim() ? (t[k] as string) : DEFAULT_THEMES[k];
  // messageTemplates: object 以外は無視。各 key は string のみ採用 (空欄含む)。
  let messageTemplates: MessageTemplates | undefined;
  if (o.messageTemplates && typeof o.messageTemplates === "object") {
    const m = o.messageTemplates as { reminder?: unknown; close?: unknown };
    const r = typeof m.reminder === "string" ? m.reminder : undefined;
    const cl = typeof m.close === "string" ? m.close : undefined;
    if (r !== undefined || cl !== undefined) {
      messageTemplates = { reminder: r, close: cl };
    }
  }
  // PR9: reminderTime / closeTime は HH:MM。未設定 / 不正は default に fallback。
  // 5 分単位への丸めも実施 (cron 粒度に合わせる)。
  const roleId =
    typeof o.roleId === "string" && o.roleId.trim() ? o.roleId : undefined;
  return {
    channelId: o.channelId,
    roleId,
    themes: { mon: pick("mon"), tue: pick("tue"), wed: pick("wed"), thu: pick("thu"), fri: pick("fri") },
    messageTemplates,
    reminderTime: normalizeFireTime(o.reminderTime, DEFAULT_REMINDER_TIME),
    closeTime: normalizeFireTime(o.closeTime, DEFAULT_CLOSE_TIME),
  };
}

function reminderBlocks(
  aid: string, ymdC: string, body: string,
): Block[] {
  return [
    mrkdwnSection(body),
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
  templates: MessageTemplates | undefined,
  roleId: string | undefined,
): Promise<boolean> {
  const dedupKey = `morning_standup:${actionId}:${ymdCompact}:${phase}`;
  const d1 = drizzle(db);
  if (!(await reservePending(d1, dedupKey, actionId, phase))) return false;

  let text: string;
  let blocks: Block[];
  if (phase === "reminder") {
    // PR10: reminder のみメンション。close は重いので付けない。
    // roleId 未設定 / メンバー 0 件 → "" (template 側で空行抑制)。
    const mentions = roleId
      ? buildMentionString(
          (await d1.select({ slackUserId: slackRoleMembers.slackUserId })
            .from(slackRoleMembers)
            .where(eq(slackRoleMembers.roleId, roleId)).all())
            .map((r) => r.slackUserId),
        )
      : "";
    const body = buildReminderText(templates, {
      theme, dayLabel: DOW_LABEL[themeKey], date: ymd, mentions,
    });
    text = `今日の朝活: ${theme}`;
    blocks = reminderBlocks(actionId, ymdCompact, body);
  } else {
    const rows = await d1.select().from(morningAttendance)
      .where(and(eq(morningAttendance.eventActionId, actionId), eq(morningAttendance.date, ymd))).all();
    const count = rows.filter((r) => r.status === "attended").length;
    const body = buildCloseText(templates, { date: ymd, count });
    text = `朝活、締め切りです (${ymd})`;
    blocks = [mrkdwnSection(body)];
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
