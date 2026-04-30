import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import { events, eventActions } from "../db/schema";

// ADR-0008: event.type ごとのデフォルトアクションマップ
const DEFAULT_ACTIONS_BY_TYPE: Record<string, string[]> = {
  meetup: ["schedule_polling"],
  hackathon: ["task_management"],
  project: [], // チーム開発系。デフォルトなし、kota が手動追加
};

/**
 * 既存 events に対して、type に応じた default action を冪等に投入。
 * 既存 (event_id, action_type) ペアがあればスキップ（UNIQUE 制約に依存 + 明示チェック）。
 */
export async function ensureDefaultActions(db: D1Database): Promise<{
  scanned: number;
  inserted: number;
  skipped: number;
}> {
  const d1 = drizzle(db);
  const allEvents = await d1.select().from(events).all();

  let inserted = 0;
  let skipped = 0;

  for (const ev of allEvents) {
    const defaults = DEFAULT_ACTIONS_BY_TYPE[ev.type] || [];
    for (const actionType of defaults) {
      // 既存チェック
      const existing = await d1
        .select()
        .from(eventActions)
        .where(
          and(
            eq(eventActions.eventId, ev.id),
            eq(eventActions.actionType, actionType),
          ),
        )
        .get();
      if (existing) {
        skipped++;
        continue;
      }
      const now = new Date().toISOString();
      try {
        await d1.insert(eventActions).values({
          id: crypto.randomUUID(),
          eventId: ev.id,
          actionType,
          config: "{}",
          enabled: 1,
          createdAt: now,
          updatedAt: now,
        });
        inserted++;
      } catch (e) {
        // UNIQUE 違反等のレースケース
        skipped++;
      }
    }
  }

  return {
    scanned: allEvents.length,
    inserted,
    skipped,
  };
}
