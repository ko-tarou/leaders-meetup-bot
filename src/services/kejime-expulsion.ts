// 朝勉強会けじめ制度: 激辛ラーメン 3 杯到達で朝活会から自動除名する。
//
// 仕様:
//   - 判定は「記録確定時」のみ: ガチャ抽選確定 (drawPendingGacha) と admin の
//     ポイント直接編集 (edit-points)。判定と通知は同一処理内で行うため
//     「通知前に遡及修正で 3 未満へ戻る」窓は実質存在しない。
//   - 除名 = expelled_at 記録 + kejime_events(type='expulsion') 追記 +
//     朝活ロール名簿 (slack_role_members) から削除 + けじめチャンネルへ通知。
//   - 遡及修正で後から 3 未満に戻っても自動復帰しない (通知済み扱い)。
//     手動復帰 = 激辛リセット (expelled_at を NULL に戻す) + ロール再追加。
//   - 二重除名は expelled_at IS NULL 条件の atomic UPDATE で防ぐ。

import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { eventActions, kejimeEvents, kejimeMembers, slackRoleMembers } from "../db/schema";
import type { SlackClient } from "./slack-api";

export const EXPULSION_RAMEN_THRESHOLD = 3;

function parseKey(raw: string | null | undefined, key: string): string | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const v = o[key];
    return typeof v === "string" && v.trim() ? v : null;
  } catch { return null; }
}

/**
 * ramen_count が閾値 (3) 以上なら除名を実行する。閾値未満 / 除名済みは noop。
 * 通知失敗・名簿削除失敗は fail-soft (除名記録自体は確定させる)。
 */
export async function checkAndExpelIfNeeded(
  db: D1Database, slackClient: SlackClient | null,
  trackerActionId: string, memberId: string,
): Promise<{ expelled: boolean }> {
  const d1 = drizzle(db);
  const member = await d1.select().from(kejimeMembers)
    .where(eq(kejimeMembers.id, memberId)).get();
  if (!member || member.expelledAt || member.ramenCount < EXPULSION_RAMEN_THRESHOLD) {
    return { expelled: false };
  }
  // atomic: expelled_at IS NULL の行だけ更新。changes!==1 なら並行処理が先に除名済み。
  const now = new Date().toISOString();
  const upd = await db.prepare(
    "UPDATE kejime_members SET expelled_at=?, updated_at=? WHERE id=? AND expelled_at IS NULL",
  ).bind(now, now, memberId).run();
  if (((upd.meta as { changes?: number } | undefined)?.changes ?? 0) !== 1) {
    return { expelled: false };
  }
  await d1.insert(kejimeEvents).values({
    id: crypto.randomUUID(), memberId, type: "expulsion",
    pointsDelta: 0, ramenDelta: 0, decidedBy: "system",
    note: `激辛ラーメン ${member.ramenCount} 杯到達により自動除名`, occurredAt: now,
  });

  // 朝活の名簿 (slack_role_members) から外す。roleId は kejime_tracker.config と
  // 同 event の morning_standup.config の両方を見る (出席ダッシュボードの
  // resolveRoleId と同じ探索範囲。設定がどちら側にあっても名簿から確実に消す)。
  const tracker = await d1.select().from(eventActions)
    .where(eq(eventActions.id, trackerActionId)).get();
  const roleIds = new Set<string>();
  const trackerRole = parseKey(tracker?.config, "roleId");
  if (trackerRole) roleIds.add(trackerRole);
  if (tracker) {
    const morning = await d1.select().from(eventActions).where(and(
      eq(eventActions.eventId, tracker.eventId),
      eq(eventActions.actionType, "morning_standup"),
    )).get();
    const morningRole = parseKey(morning?.config, "roleId");
    if (morningRole) roleIds.add(morningRole);
  }
  for (const roleId of roleIds) {
    try {
      await d1.delete(slackRoleMembers).where(and(
        eq(slackRoleMembers.roleId, roleId),
        eq(slackRoleMembers.slackUserId, member.slackUserId),
      ));
    } catch (e) {
      console.warn(`kejime expulsion: roster delete failed (role=${roleId}):`, e);
    }
  }

  // 除名通知: kejime_tracker.config.kejimeChannelId (status post と同じ経路)。
  const channelId = parseKey(tracker?.config, "kejimeChannelId");
  if (channelId && slackClient) {
    try {
      await slackClient.postMessage(
        channelId,
        `:rotating_light: *除名通知* <@${member.slackUserId}> さんは激辛ラーメンが` +
          `${member.ramenCount} 杯貯まったため、朝活会から除名となりました。` +
          "復帰は管理者にご相談ください。",
      );
    } catch (e) {
      console.warn(`kejime expulsion: notify failed (member=${memberId}):`, e);
    }
  }
  return { expelled: true };
}
