import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { slackCache } from "../db/schema";
import type { SlackClient } from "./slack-api";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1日

export async function getUserName(
  db: D1Database,
  client: SlackClient,
  userId: string,
): Promise<string> {
  return resolveName(db, client, "user", userId, async () => {
    const info = await client.getUserInfo(userId);
    if (!info.ok) return userId;
    const user = info.user as {
      name?: string;
      profile?: {
        display_name_normalized?: string;
        real_name_normalized?: string;
      };
    } | undefined;
    return (
      user?.profile?.display_name_normalized ||
      user?.profile?.real_name_normalized ||
      user?.name ||
      userId
    );
  });
}

export async function getChannelName(
  db: D1Database,
  client: SlackClient,
  channelId: string,
): Promise<string> {
  return resolveName(db, client, "channel", channelId, async () => {
    const info = await client.getChannelInfo(channelId);
    if (!info.ok) return channelId;
    const ch = info.channel as { name?: string } | undefined;
    return ch?.name ?? channelId;
  });
}

async function resolveName(
  db: D1Database,
  _client: SlackClient,
  kind: "user" | "channel",
  id: string,
  fetcher: () => Promise<string>,
): Promise<string> {
  const d1 = drizzle(db);
  const cacheKey = `${kind}:${id}`;

  const cached = await d1
    .select()
    .from(slackCache)
    .where(eq(slackCache.id, cacheKey))
    .get();
  if (cached) {
    const age = Date.now() - new Date(cached.fetchedAt).getTime();
    if (age < CACHE_TTL_MS) return cached.name;
  }

  try {
    const name = await fetcher();
    const now = new Date().toISOString();
    if (cached) {
      await d1
        .update(slackCache)
        .set({ name, fetchedAt: now })
        .where(eq(slackCache.id, cacheKey));
    } else {
      await d1.insert(slackCache).values({ id: cacheKey, name, fetchedAt: now });
    }
    return name;
  } catch {
    // フェッチ失敗時はキャッシュがあればそれを返す、なければIDを返す
    return cached?.name ?? id;
  }
}

export async function getUserNames(
  db: D1Database,
  client: SlackClient,
  userIds: string[],
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  await Promise.all(
    userIds.map(async (id) => {
      result[id] = await getUserName(db, client, id);
    }),
  );
  return result;
}
