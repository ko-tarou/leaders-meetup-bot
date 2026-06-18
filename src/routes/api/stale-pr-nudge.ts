/**
 * stale-pr-nudge の手動発火 API。
 *
 * 自動 cron (平日 nudgeTime 窓) を待たず、講師 / 管理者が任意のタイミングで
 * 「停滞 PR リマインド」を即発火するための admin エンドポイント。
 *
 * cron 経路 (processStalePrNudges → nudgeOneAction) と完全に同じ
 * 取得 / stale 判定 / mention 解決 / 投稿 / 同日 dedup を共有する
 * (nudgeActionById がラップ。ロジック二重化なし)。平日判定 + 時間窓のみ
 * スキップする (手動は明示操作のため)。同日二重催促ガードは残すので、
 * 連打や cron との競合でも同一 PR を二重投稿しない。
 *
 * Endpoint (api.ts の adminAuth で保護される):
 *   POST /orgs/:eventId/actions/:actionId/stale-pr-nudge/send
 *     → { ok: true, nudged: number }   実際に催促投稿した PR 件数
 *        (全 PR が同日 dedup 済み / stale でなければ 0)
 */
import { Hono } from "hono";
import type { Env } from "../../types/env";
import { nudgeActionById } from "../../services/stale-pr-nudge";

export const stalePrNudgeRouter = new Hono<{ Bindings: Env }>();

const BASE = "/orgs/:eventId/actions/:actionId/stale-pr-nudge";

stalePrNudgeRouter.post(`${BASE}/send`, async (c) => {
  const eventId = c.req.param("eventId");
  const actionId = c.req.param("actionId");

  const res = await nudgeActionById(c.env.DB, c.env, eventId, actionId);
  if (!res.ok) {
    // action 不在 / 別 actionType → 404、config 不正 (設定未完了) → 400。
    const status = res.error === "invalid_config" ? 400 : 404;
    return c.json({ ok: false, error: res.error }, status);
  }
  return c.json({ ok: true, nudged: res.nudged });
});
