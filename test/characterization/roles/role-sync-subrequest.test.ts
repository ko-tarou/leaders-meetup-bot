/**
 * 回帰網: メンバー同期の "Too many subrequests" 根治検証。
 *
 * 目的: 1 Worker invocation あたりの Slack subrequest (fetch) 総数が Cloudflare
 * free plan の上限 (50) を **構造的に** 超えないことを、実 SlackClient +
 * globalThis.fetch スタブで end-to-end に固定する。
 *
 * ここが従来テスト (slack-api を mock) との決定的な違い:
 *   - slack-api を mock すると conversations.members / conversations.list の
 *     **ページング (cursor で複数 subrequest)** が消えてしまい、本バグの本丸
 *     (1 チャンネル = 最大 20 subrequest, getChannelList = 最大 20 subrequest) を
 *     再現できない。
 *   - 本テストは **実 SlackClient** を使い、fetch をスタブして cursor ページングを
 *     忠実に再現し、実際に飛ぶ fetch 回数を数える。
 *
 * ★前回修正 (PR#399) が効かなかった真因の再現:
 *   分割単位が「チャンネル数 (5/req)」だったため、大きい channel が数個あるだけで
 *   5×(最大20) + getChannelList(最大20) + auth(1) が 50 を超えていた。
 *   本テストは各 channel が 5 subrequest, getChannelList が 3 subrequest を要する
 *   環境で、budget ベースの新実装が 1 invocation を常に <50 に保つことを assert する。
 */
import { describe, it, expect, afterEach } from "vitest";
import { computeSyncDiff, SYNC_SUBREQUEST_BUDGET } from "../../../src/services/role-sync";
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

// ---- fetch スタブ: cursor ページングを忠実に再現し subrequest を数える ----

type FetchStubOpts = {
  // conversations.list を何ページに分けるか (getChannelList のコスト)。
  channelListPages: number;
  // 存在する managed channel の一覧 (list レスポンスに含める)。
  channelIds: string[];
  // 1 channel の conversations.members を何ページに分けるか (channel ごとのコスト)。
  memberPagesPerChannel: number;
  // 各 channel の members (全ページ合算で返すユーザー)。
  membersPerChannel: string[];
  // conversations.members を巨大化させたい channel (memberPagesPerChannel を無視して
  // hugePages ページ返す = フル予算でも取り切れないケースの再現)。
  hugeChannels?: Record<string, number>;
};

let fetchCallsThisInvocation = 0;
const perInvocationPeaks: number[] = [];

function installFetchStub(opts: FetchStubOpts) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
    fetchCallsThisInvocation += 1;
    const url = new URL(String(input));
    const method = url.pathname.split("/api/")[1] ?? "";
    const params = url.searchParams;
    const cursorNum = params.get("cursor")
      ? Number.parseInt(params.get("cursor")!.replace(/\D/g, ""), 10) || 0
      : 0;

    const json = (body: unknown) => ({ json: async () => body });

    if (method === "auth.test") {
      return json({ ok: true, user_id: "U-BOT" });
    }
    if (method === "conversations.list") {
      // channelListPages ページに分割。最終ページ以外は next_cursor を返す。
      const page = cursorNum; // 0-based
      const isLast = page >= opts.channelListPages - 1;
      // channel は最初のページにまとめて入れておけば十分 (名前解決用)。
      const channels =
        page === 0
          ? opts.channelIds.map((id) => ({ id, name: `name-${id}` }))
          : [];
      return json({
        ok: true,
        channels,
        response_metadata: isLast ? {} : { next_cursor: `L${page + 1}` },
      });
    }
    if (method === "conversations.members") {
      const channel = params.get("channel") ?? "";
      const totalPages = opts.hugeChannels?.[channel] ?? opts.memberPagesPerChannel;
      const page = cursorNum; // 0-based
      const isLast = page >= totalPages - 1;
      // members は最初のページにまとめて返す (合算集合の正しさ検証用)。
      const members = page === 0 ? opts.membersPerChannel : [];
      return json({
        ok: true,
        members,
        response_metadata: isLast ? {} : { next_cursor: `m${page + 1}` },
      });
    }
    return json({ ok: false, error: `unexpected_method:${method}` });
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

let restoreFetch: (() => void) | null = null;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
  perInvocationPeaks.length = 0;
});

describe("メンバー同期: subrequest 総数が構造的に 50 未満 (実 fetch カウント)", () => {
  it("大規模 (30ch × 5 memberページ + list 3ページ) を paging で網羅し、各 invocation は常に <50 subrequest", async () => {
    const channelIds = Array.from({ length: 30 }, (_, i) => `C${i}`);
    const members = ["U0", "U1", "U2", "U3", "U4"]; // 期待 = 現状 (差分なし)
    const action = await seed(channelIds, members);

    restoreFetch = installFetchStub({
      channelListPages: 3,
      channelIds,
      memberPagesPerChannel: 5, // 1 channel = 5 subrequest
      membersPerChannel: members,
    });

    // 旧実装 (5ch/req 固定) ならこの設定で 1 req = 1(auth)+3(list)+5×5(members)=29..
    // だが大 channel が増えれば容易に 50 超。新実装は budget で常に <50 を保証する。
    const collected: string[] = [];
    const errors: string[] = [];
    let offset: number | null = 0;
    let invocations = 0;
    const guard = 500;
    while (offset !== null && invocations < guard) {
      fetchCallsThisInvocation = 0;
      const res = await computeSyncDiff(makeEnv(), action, undefined, { offset });
      perInvocationPeaks.push(fetchCallsThisInvocation);
      // ★核心の assert: 1 invocation の subrequest 総数が上限 (50) 未満、かつ budget 以下。
      expect(fetchCallsThisInvocation).toBeLessThan(50);
      expect(fetchCallsThisInvocation).toBeLessThanOrEqual(SYNC_SUBREQUEST_BUDGET);
      for (const ch of res.channels) {
        collected.push(ch.channelId);
        if (ch.error) errors.push(`${ch.channelId}:${ch.error}`);
        // 差分なし (期待 = 現状) を確認。
        expect(ch.toInvite).toEqual([]);
        expect(ch.toKick).toEqual([]);
      }
      offset = res.nextOffset ?? null;
      invocations++;
    }

    // 全 30 channel を重複なく網羅し、error は 0。
    expect(errors).toEqual([]);
    expect(collected.sort()).toEqual([...channelIds].sort());
    expect(collected).toHaveLength(30);
    // paging が実際に発火している (1 invocation で終わっていない) こと。
    expect(invocations).toBeGreaterThan(1);
    // 少なくとも 1 回は 20 subrequest 超 = 旧「5ch上限」より多く詰めつつ <50 を維持。
    expect(Math.max(...perInvocationPeaks)).toBeGreaterThan(20);
    expect(Math.max(...perInvocationPeaks)).toBeLessThan(50);
  });

  it("フル予算でも取り切れない巨大 channel は error 扱い (kick 事故防止) で budget も超えない", async () => {
    const channelIds = ["C0", "CBIG", "C1"];
    const members = ["U0", "U1"];
    const action = await seed(channelIds, members);

    restoreFetch = installFetchStub({
      channelListPages: 1,
      channelIds,
      memberPagesPerChannel: 2,
      membersPerChannel: members,
      // CBIG は 100 ページ必要 = フル予算 (20) でも取り切れない → 不完全 → error。
      hugeChannels: { CBIG: 100 },
    });

    const collected: Record<string, string | null> = {};
    let offset: number | null = 0;
    let invocations = 0;
    while (offset !== null && invocations < 500) {
      fetchCallsThisInvocation = 0;
      const res = await computeSyncDiff(makeEnv(), action, undefined, { offset });
      expect(fetchCallsThisInvocation).toBeLessThan(50);
      for (const ch of res.channels) collected[ch.channelId] = ch.error ?? null;
      offset = res.nextOffset ?? null;
      invocations++;
    }

    // 全 channel 到達。CBIG のみ error、他は正常 (error なし)。
    expect(Object.keys(collected).sort()).toEqual(["C0", "C1", "CBIG"]);
    expect(collected["C0"]).toBeNull();
    expect(collected["C1"]).toBeNull();
    expect(collected["CBIG"]).toBe("members_incomplete_subrequest_budget");
  });
});
