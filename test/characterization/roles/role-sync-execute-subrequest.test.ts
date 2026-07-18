/**
 * 回帰網: executeSync (POST /sync 実行経路) の subrequest 上限根治検証。
 *
 * diff 計算 (GET /sync-diff) だけでなく **実行経路** も 1 invocation あたり
 * subrequest < 50 を守ることを、実 SlackClient + stateful fetch スタブで固定する。
 *
 * 実行経路のコスト = auth(1) + members(ページング) + invite(bulk) + kick(per-user)。
 * kick は 1 user = 1 subrequest なので、kick 対象が多い channel は単体で 50 を
 * 超え得る (前回修正では未対応)。新実装は budget を超える手前で残りを deferred に
 * 積んで返し、フロント (テストではドレインループ) が空になるまで再送する。
 *
 * stateful スタブ: conversations.kick / conversations.invite が現状メンバー集合を
 * 実際に更新し、conversations.members がその集合を返す = 再送で収束することを検証。
 */
import { describe, it, expect, afterEach } from "vitest";
import { executeSync, SYNC_SUBREQUEST_BUDGET } from "../../../src/services/role-sync";
import { makeEnv } from "../../helpers/env";
import { testDb } from "../../helpers/db";
import {
  makeEvent,
  makeEventAction,
  makeEncryptedWorkspace,
  makeSlackRole,
  makeSlackRoleMember,
} from "../../helpers/factory";
import { slackRoleChannels } from "../../../src/db/schema";

let fetchCalls = 0;

// channelId -> 現状メンバー集合 (Set)。kick/invite で更新される。
function installStatefulFetch(current: Record<string, Set<string>>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    input: unknown,
    init?: { method?: string; body?: string },
  ) => {
    fetchCalls += 1;
    const url = new URL(String(input));
    const method = url.pathname.split("/api/")[1] ?? "";
    const json = (body: unknown) => ({ json: async () => body });

    if (method === "auth.test") return json({ ok: true, user_id: "U-BOT" });

    if (method === "conversations.members") {
      // 全メンバーを 1 ページ (< 200) で返す。cursor 実装は他テストで検証済み。
      const channel = url.searchParams.get("channel") ?? "";
      return json({ ok: true, members: [...(current[channel] ?? new Set())] });
    }
    // 以下は POST (callApi) 経由 = body に JSON。
    const parsed = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (method === "conversations.kick") {
      const channel = String(parsed.channel);
      const user = String(parsed.user);
      current[channel]?.delete(user);
      return json({ ok: true });
    }
    if (method === "conversations.invite") {
      const channel = String(parsed.channel);
      const users = String(parsed.users).split(",");
      for (const u of users) current[channel]?.add(u);
      return json({ ok: true });
    }
    return json({ ok: false, error: `unexpected:${method}` });
  }) as unknown as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

async function seed(channelIds: string[], members: string[]) {
  const { row: ws } = await makeEncryptedWorkspace();
  const ev = await makeEvent();
  const action = await makeEventAction(ev.id, {
    actionType: "role_management",
    config: JSON.stringify({ workspaceId: ws.id }),
  });
  const role = await makeSlackRole(action.id, { name: "R" });
  for (const m of members) await makeSlackRoleMember(role.id, m);
  for (const ch of channelIds) {
    await testDb()
      .insert(slackRoleChannels)
      .values({ roleId: role.id, channelId: ch, addedAt: "2026-05-17T00:00:00.000Z" });
  }
  return action;
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("executeSync: subrequest 総数が構造的に 50 未満 + deferred で収束", () => {
  it("1 channel に大量 kick (80 名) でも各 invocation <50、deferred 再送で全員 kick 完了", async () => {
    // 期待メンバー無し (role member 0) → channel の 80 名全員が toKick。
    const action = await seed(["CBIG"], []);
    const current: Record<string, Set<string>> = {
      CBIG: new Set(Array.from({ length: 80 }, (_, i) => `U${i}`)),
    };
    restore = installStatefulFetch(current);

    // フロントのドレインループを模擬: deferred が空になるまで再送する。
    let queue = [{ channelId: "CBIG", invite: false, kick: true }];
    let totalKicked = 0;
    let invocations = 0;
    const errors: unknown[] = [];
    while (queue.length > 0 && invocations < 50) {
      fetchCalls = 0;
      const res = await executeSync(makeEnv(), action, queue);
      // ★核心: 実行経路も 1 invocation で 50 subrequest 未満。
      expect(fetchCalls).toBeLessThan(50);
      expect(fetchCalls).toBeLessThanOrEqual(SYNC_SUBREQUEST_BUDGET);
      totalKicked += res.kicked;
      errors.push(...res.errors);
      queue = res.deferred ?? [];
      invocations++;
    }

    // 80 名全員 kick、error なし、現状メンバー 0 に収束。
    expect(errors).toEqual([]);
    expect(totalKicked).toBe(80);
    expect(current.CBIG.size).toBe(0);
    // 1 invocation では終わらず deferred 再送が発火したこと。
    expect(invocations).toBeGreaterThan(1);
  });

  it("小規模 (差分わずか) は 1 invocation で完了し deferred は付かない", async () => {
    const action = await seed(["C0"], ["U0", "U1"]); // 期待 = U0,U1
    const current: Record<string, Set<string>> = {
      C0: new Set(["U1", "Uextra"]), // U0 招待, Uextra kick
    };
    restore = installStatefulFetch(current);

    fetchCalls = 0;
    const res = await executeSync(makeEnv(), action, [
      { channelId: "C0", invite: true, kick: true },
    ]);
    expect(fetchCalls).toBeLessThan(50);
    expect(res.deferred).toBeUndefined();
    expect(res.invited).toBe(1); // U0
    expect(res.kicked).toBe(1); // Uextra
    expect(current.C0).toEqual(new Set(["U0", "U1"]));
  });
});
