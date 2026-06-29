/**
 * stale-pr-nudge characterization / unit。
 *
 * `src/services/stale-pr-nudge.ts` の挙動を固定する:
 *   - pure 関数 (parseStalePrNudgeConfig / isStale / isWithinFireWindow /
 *     jstDayOfWeek / isWeekday / makeDedupKey / buildDigestText)
 *   - cron 本体 processStalePrNudges (平日窓 + GitHub fetch stub + mapping 解決 +
 *     dedup + fail-soft)
 *
 * 外部 I/O:
 *   - GitHub API は globalThis.fetch を vi.stubGlobal で差し替え (実 API 非接触)。
 *   - Slack は workspace の DI seam (setSlackClientProvider) で fake client に
 *     差し替え、getSlackClientForChannel が引く meetings 行を seed する。
 *
 * 時刻凍結: getJstNow が Date.now()+9h を UTC 読みする実装なので
 * vi.setSystemTime(new Date("...+09:00")) で JST 壁時計を固定する。
 * 基準: 2026-05-18 = 月曜 (平日), 2026-05-23 = 土曜 (週末)。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";

import {
  processStalePrNudges,
  nudgeActionById,
  parseStalePrNudgeConfig,
  isStale,
  isWithinFireWindow,
  jstDayOfWeek,
  isWeekday,
  makeDedupKey,
  buildDigestText,
  buildDigestBlocks,
  buildMention,
} from "../../../src/services/stale-pr-nudge";
import {
  setSlackClientProvider,
  resetSlackClientProvider,
} from "../../../src/services/workspace";
import { testD1, testDb } from "../../helpers/db";
import { makeEnv } from "../../helpers/env";
import {
  makeEvent,
  makeEventAction,
  makeMeeting,
  makeWorkspace,
} from "../../helpers/factory";
import {
  eventActions,
  scheduledJobs,
  githubUserMappings,
} from "../../../src/db/schema";

const env = makeEnv();

const MON_YMD = "2026-05-18"; // 月曜
const SAT_YMD = "2026-05-23"; // 土曜
const NUDGE_CHANNEL = "C-NUDGE";

function freezeJst(ymd: string, hm: string) {
  vi.setSystemTime(new Date(`${ymd}T${hm}:00.000+09:00`));
}

/**
 * fake Slack client。postMessage の (channel, text, blocks) と
 * deleteMessage の (channel, ts) を記録する。delete+repost 検証のため
 * postMessage は呼び出しごとに一意な ts ("1.0", "2.0", ...) を返す。
 */
function setupSlackSpy(): {
  posts: Array<{ channel: string; text: string; blocks?: unknown[] }>;
  deletes: Array<{ channel: string; ts: string }>;
} {
  const posts: Array<{ channel: string; text: string; blocks?: unknown[] }> = [];
  const deletes: Array<{ channel: string; ts: string }> = [];
  let seq = 0;
  const fake = {
    postMessage: async (channel: string, text: string, blocks?: unknown[]) => {
      posts.push({ channel, text, blocks });
      seq += 1;
      return { ok: true, ts: `${seq}.0` };
    },
    deleteMessage: async (channel: string, ts: string) => {
      deletes.push({ channel, ts });
      return { ok: true };
    },
  };
  setSlackClientProvider(async () => fake as never);
  return { posts, deletes };
}

/** GitHub fetch を repo ごとに固定 PR 配列を返す stub に差し替える。 */
function stubGithub(
  byRepo: Record<string, Array<Record<string, unknown>>>,
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const m = /repos\/([^/]+\/[^/]+)\/pulls/.exec(url);
      const repo = m?.[1] ?? "";
      const prs = byRepo[repo] ?? [];
      return new Response(JSON.stringify(prs), { status: 200 });
    }),
  );
}

function cfg(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    githubRepos: ["ko-tarou/leaders-meetup-bot"],
    nudgeChannelId: NUDGE_CHANNEL,
    staleHours: 48,
    nudgeTime: "09:00",
    ...over,
  });
}

/** stale な PR (updated_at が十分過去)。 */
function stalePr(over: Record<string, unknown> = {}) {
  return {
    number: 42,
    html_url: "https://github.com/ko-tarou/leaders-meetup-bot/pull/42",
    title: "Add stale PR nudge",
    updated_at: "2026-05-10T00:00:00Z", // 基準 (5/18) から 8 日前 = stale
    requested_reviewers: [{ login: "octocat" }],
    ...over,
  };
}

beforeEach(async () => {
  vi.useFakeTimers();
  freezeJst(MON_YMD, "09:00");
  const db = testDb();
  await db.delete(scheduledJobs);
  await db.delete(eventActions);
  await db.delete(githubUserMappings);
  // getSlackClientForChannel が nudgeChannelId から workspace を引けるよう
  // workspace + meetings 行を seed (provider override 下で client 解決経路を満たす)。
  const ws = await makeWorkspace();
  await makeMeeting({ channelId: NUDGE_CHANNEL, workspaceId: ws.id });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetSlackClientProvider();
});

// ============ pure 関数 ============

describe("parseStalePrNudgeConfig", () => {
  it("必須揃いで検証済み config を返す", () => {
    expect(
      parseStalePrNudgeConfig(
        JSON.stringify({
          githubRepos: ["a/b"],
          nudgeChannelId: "C1",
          staleHours: 24,
          nudgeTime: "10:30",
        }),
      ),
    ).toEqual({
      githubRepos: ["a/b"],
      nudgeChannelId: "C1",
      staleHours: 24,
      nudgeTime: "10:30",
    });
  });

  it("staleHours/nudgeTime 省略は既定 (48 / 09:00)", () => {
    const c = parseStalePrNudgeConfig(
      JSON.stringify({ githubRepos: ["a/b"], nudgeChannelId: "C1" }),
    );
    expect(c?.staleHours).toBe(48);
    expect(c?.nudgeTime).toBe("09:00");
  });

  it("githubRepos が空 → null (no-op)", () => {
    expect(
      parseStalePrNudgeConfig(
        JSON.stringify({ githubRepos: [], nudgeChannelId: "C1" }),
      ),
    ).toBeNull();
  });

  it("owner/repo 形式でない要素は除外、全滅なら null", () => {
    expect(
      parseStalePrNudgeConfig(
        JSON.stringify({ githubRepos: ["nope", "a/b/c"], nudgeChannelId: "C1" }),
      ),
    ).toBeNull();
    const c = parseStalePrNudgeConfig(
      JSON.stringify({ githubRepos: ["bad", "ok/repo"], nudgeChannelId: "C1" }),
    );
    expect(c?.githubRepos).toEqual(["ok/repo"]);
  });

  it("nudgeChannelId 欠落 → null", () => {
    expect(
      parseStalePrNudgeConfig(JSON.stringify({ githubRepos: ["a/b"] })),
    ).toBeNull();
  });

  it("不正 JSON / null → null", () => {
    expect(parseStalePrNudgeConfig("{broken")).toBeNull();
    expect(parseStalePrNudgeConfig(null)).toBeNull();
    expect(parseStalePrNudgeConfig(undefined)).toBeNull();
  });

  it("不正 nudgeTime は既定にフォールバック", () => {
    const c = parseStalePrNudgeConfig(
      JSON.stringify({
        githubRepos: ["a/b"],
        nudgeChannelId: "C1",
        nudgeTime: "9am",
      }),
    );
    expect(c?.nudgeTime).toBe("09:00");
  });
});

describe("isStale", () => {
  const now = Date.parse("2026-05-18T09:00:00Z");
  it("staleHours ちょうど経過 → stale", () => {
    const updated = new Date(now - 48 * 3600 * 1000).toISOString();
    expect(isStale(updated, 48, now)).toBe(true);
  });
  it("staleHours 未満 → not stale", () => {
    const updated = new Date(now - 47 * 3600 * 1000).toISOString();
    expect(isStale(updated, 48, now)).toBe(false);
  });
  it("不正な updated_at → false", () => {
    expect(isStale("not-a-date", 48, now)).toBe(false);
  });
});

describe("isWithinFireWindow (9 分窓)", () => {
  it("ちょうど / 末端 / 窓外", () => {
    expect(isWithinFireWindow(9, 0, "09:00")).toBe(true);
    expect(isWithinFireWindow(9, 8, "09:00")).toBe(true);
    expect(isWithinFireWindow(9, 9, "09:00")).toBe(false);
    expect(isWithinFireWindow(8, 59, "09:00")).toBe(false);
  });
});

describe("jstDayOfWeek / isWeekday", () => {
  it("2026-05-18 は月曜 (1) で平日", () => {
    const ms = Date.parse("2026-05-18T09:00:00+09:00");
    expect(jstDayOfWeek(ms)).toBe(1);
    expect(isWeekday(1)).toBe(true);
  });
  it("2026-05-23 は土曜 (6) で非平日", () => {
    const ms = Date.parse("2026-05-23T09:00:00+09:00");
    expect(jstDayOfWeek(ms)).toBe(6);
    expect(isWeekday(6)).toBe(false);
  });
});

describe("makeDedupKey", () => {
  it("stale_pr_nudge:{repo}:{pr}:{ymd}", () => {
    expect(makeDedupKey("a/b", 42, "20260518")).toBe(
      "stale_pr_nudge:a/b:42:20260518",
    );
  });
});

describe("buildMention", () => {
  it("mapping 有り → <@SlackID> (実メンション)", () => {
    expect(buildMention("octocat", "U-OCTO")).toBe("<@U-OCTO>");
  });
  it("mapping 無し → GitHub プロフィールリンク (誤メンションしない)", () => {
    expect(buildMention("octocat", null)).toBe(
      "<https://github.com/octocat|@octocat>",
    );
    expect(buildMention("octocat", undefined)).toBe(
      "<https://github.com/octocat|@octocat>",
    );
  });
});

describe("buildDigestText (通知フォールバック)", () => {
  it("サマリ行 + PR 1 行ずつ。メンション群 + 停滞日数 + URL を含む", () => {
    const text = buildDigestText(
      [
        {
          mentions: ["<@U1>", "<https://github.com/foo|@foo>"],
          title: "My PR",
          url: "http://x/1",
          staleDays: 3,
        },
        { mentions: ["<@U2>"], title: "Second PR", url: "http://x/2", staleDays: 5 },
      ],
      48,
    );
    expect(text).toBe(
      "🔍 レビュー待ちの PR 2 件 (48時間以上更新が止まっています)\n" +
        "\n" +
        "• <@U1> <https://github.com/foo|@foo> My PR (⏳3日 停滞)\nhttp://x/1\n" +
        "• <@U2> Second PR (⏳5日 停滞)\nhttp://x/2",
    );
  });
  it("メンション無し (未割当) の行は <!channel> (@channel) を行頭に置く", () => {
    const text = buildDigestText(
      [{ mentions: [], title: "T", url: "http://x", staleDays: 2 }],
      24,
    );
    expect(text).toContain("🔍 レビュー待ちの PR 1 件 (24時間以上更新が止まっています)");
    expect(text).toContain("• <!channel> T (⏳2日 停滞)\nhttp://x");
  });
});

describe("buildDigestBlocks (見やすいレイアウト)", () => {
  it("header + divider + 各 PR section + footer。状態/停滞日数/担当が分かる", () => {
    const blocks = buildDigestBlocks(
      [
        { mentions: ["<@U1>"], title: "My PR", url: "http://x/1", staleDays: 3 },
        { mentions: [], title: "Orphan PR", url: "http://x/2", staleDays: 7 },
      ],
      48,
    ) as Array<Record<string, unknown>>;
    // 先頭は header、2 つ目は divider
    expect(blocks[0]).toMatchObject({ type: "header" });
    expect((blocks[0].text as { text: string }).text).toBe(
      "🔍 レビュー待ちの PR (2件)",
    );
    expect(blocks[1]).toMatchObject({ type: "divider" });
    // 全体を直列化して中身を検証 (タイトルリンク / 停滞日数 / メンション)。
    const json = JSON.stringify(blocks);
    expect(json).toContain("<http://x/1|My PR>");
    expect(json).toContain("3日 更新なし");
    expect(json).toContain("<@U1>");
    // 未割当 PR は <!channel> を担当に出す。
    expect(json).toContain("<!channel>");
    expect(json).toContain("7日 更新なし");
  });

  it("MAX_DIGEST_BLOCK_ITEMS (20) を超える分はフッターに「他 N 件」", () => {
    const items = Array.from({ length: 23 }, (_, i) => ({
      mentions: ["<@U1>"],
      title: `PR ${i}`,
      url: `http://x/${i}`,
      staleDays: 3,
    }));
    const blocks = buildDigestBlocks(items, 48) as Array<Record<string, unknown>>;
    const json = JSON.stringify(blocks);
    // header の件数は総数 (23) を表示。
    expect(json).toContain("🔍 レビュー待ちの PR (23件)");
    // 21..23 件目 (3 件) は省略され footer に出る。
    expect(json).toContain("ほか 3 件は省略");
    expect(json).not.toContain("PR 22");
  });
});

// ============ cron 本体 ============

async function seedAction(config: string, enabled = 1) {
  const ev = await makeEvent();
  return makeEventAction(ev.id, {
    actionType: "stale_pr_nudge",
    enabled,
    config,
  });
}

describe("processStalePrNudges: 対象抽出 / 窓判定", () => {
  it("平日窓内 + stale PR → mapping 解決して @メンション催促", async () => {
    const { posts } = setupSlackSpy();
    await testDb().insert(githubUserMappings).values({
      githubUsername: "octocat",
      slackUserId: "U-OCTO",
      displayName: "Octo",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    stubGithub({ "ko-tarou/leaders-meetup-bot": [stalePr()] });
    await seedAction(cfg());

    const res = await processStalePrNudges(testD1(), env);
    expect(res).toEqual({ nudged: 1 });
    expect(posts).toHaveLength(1);
    expect(posts[0].channel).toBe(NUDGE_CHANNEL);
    expect(posts[0].text).toContain("<@U-OCTO>");
    expect(posts[0].text).toContain("レビュー待ちの PR 1 件");
    expect(posts[0].text).toContain(
      "https://github.com/ko-tarou/leaders-meetup-bot/pull/42",
    );
  });

  it("★ダイジェスト: 複数の stale PR を 1 通のまとめメッセージに集約する", async () => {
    const { posts } = setupSlackSpy();
    stubGithub({
      "ko-tarou/leaders-meetup-bot": [
        stalePr({
          number: 42,
          html_url: "https://github.com/ko-tarou/leaders-meetup-bot/pull/42",
          title: "PR forty-two",
        }),
        stalePr({
          number: 43,
          html_url: "https://github.com/ko-tarou/leaders-meetup-bot/pull/43",
          title: "PR forty-three",
        }),
        stalePr({
          number: 44,
          html_url: "https://github.com/ko-tarou/leaders-meetup-bot/pull/44",
          title: "PR forty-four",
        }),
      ],
    });
    await seedAction(cfg());

    const res = await processStalePrNudges(testD1(), env);
    // nudged は集約した PR 件数。ただし投稿は 1 通だけ (チャンネルを汚さない)。
    expect(res).toEqual({ nudged: 3 });
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toContain("レビュー待ちの PR 3 件");
    expect(posts[0].text).toContain("PR forty-two");
    expect(posts[0].text).toContain("PR forty-three");
    expect(posts[0].text).toContain("PR forty-four");
    // 各 PR の dedupKey は個別に completed 化される (再送防止は PR 単位で維持)。
    const jobs = await testDb().select().from(scheduledJobs).all();
    expect(jobs).toHaveLength(3);
    expect(jobs.every((j) => j.status === "completed")).toBe(true);
    // 見やすいレイアウトのため Block Kit も付与して投稿する。
    expect(posts[0].blocks).toBeDefined();
    expect(JSON.stringify(posts[0].blocks)).toContain("レビュー待ちの PR (3件)");
  });

  it("(1) draft (WIP) PR は催促ダイジェストから除外する", async () => {
    const { posts } = setupSlackSpy();
    stubGithub({
      "ko-tarou/leaders-meetup-bot": [
        stalePr({ number: 50, title: "Draft WIP", draft: true }),
        stalePr({ number: 51, title: "Ready for review", draft: false }),
      ],
    });
    await seedAction(cfg());

    const res = await processStalePrNudges(testD1(), env);
    // draft は除外され、ready の 1 件だけが催促される。
    expect(res).toEqual({ nudged: 1 });
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toContain("Ready for review");
    expect(posts[0].text).not.toContain("Draft WIP");
    // draft 分の dedupKey 予約も発生しない (scheduledJobs は 1 件のみ)。
    const jobs = await testDb().select().from(scheduledJobs).all();
    expect(jobs).toHaveLength(1);
  });

  it("全 PR が draft → 何も投稿しない", async () => {
    const { posts } = setupSlackSpy();
    stubGithub({
      "ko-tarou/leaders-meetup-bot": [
        stalePr({ number: 60, draft: true }),
        stalePr({ number: 61, draft: true }),
      ],
    });
    await seedAction(cfg());
    const res = await processStalePrNudges(testD1(), env);
    expect(res).toEqual({ nudged: 0 });
    expect(posts).toHaveLength(0);
  });

  it("mapping 未登録レビュアーは GitHub リンク fallback (誤メンションしない)", async () => {
    const { posts } = setupSlackSpy();
    stubGithub({ "ko-tarou/leaders-meetup-bot": [stalePr()] });
    await seedAction(cfg());
    const res = await processStalePrNudges(testD1(), env);
    expect(res).toEqual({ nudged: 1 });
    expect(posts[0].text).toContain("<https://github.com/octocat|@octocat>");
    // 実メンション (<@...>) や @channel は飛ばさない (誤通知回避)。
    expect(posts[0].text).not.toContain("<@");
    expect(posts[0].text).not.toContain("<!channel>");
  });

  it("FIX2: reviewer も assignee も居ない未割当 PR は <!channel> で催促", async () => {
    const { posts } = setupSlackSpy();
    stubGithub({
      "ko-tarou/leaders-meetup-bot": [
        stalePr({ requested_reviewers: [], assignees: [] }),
      ],
    });
    await seedAction(cfg());
    const res = await processStalePrNudges(testD1(), env);
    expect(res).toEqual({ nudged: 1 });
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toContain("<!channel>");
  });

  it("FIX1: assignee も対象に含め mapping 解決して実メンションする", async () => {
    const { posts } = setupSlackSpy();
    await testDb().insert(githubUserMappings).values({
      githubUsername: "assignee1",
      slackUserId: "U-ASSIGN",
      displayName: "Assignee One",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    stubGithub({
      "ko-tarou/leaders-meetup-bot": [
        stalePr({ requested_reviewers: [], assignees: [{ login: "assignee1" }] }),
      ],
    });
    await seedAction(cfg());
    const res = await processStalePrNudges(testD1(), env);
    expect(res).toEqual({ nudged: 1 });
    expect(posts[0].text).toContain("<@U-ASSIGN>");
    expect(posts[0].text).not.toContain("<!channel>");
  });

  it("reviewer と assignee に同一 login が居ても 1 メンションに畳む", async () => {
    const { posts } = setupSlackSpy();
    await testDb().insert(githubUserMappings).values({
      githubUsername: "octocat",
      slackUserId: "U-OCTO",
      displayName: "Octo",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    stubGithub({
      "ko-tarou/leaders-meetup-bot": [
        stalePr({
          requested_reviewers: [{ login: "octocat" }],
          assignees: [{ login: "octocat" }],
        }),
      ],
    });
    await seedAction(cfg());
    await processStalePrNudges(testD1(), env);
    const occurrences = posts[0].text.split("<@U-OCTO>").length - 1;
    expect(occurrences).toBe(1);
  });

  it("土曜 (週末) → 走らない", async () => {
    freezeJst(SAT_YMD, "09:00");
    const { posts } = setupSlackSpy();
    stubGithub({ "ko-tarou/leaders-meetup-bot": [stalePr()] });
    await seedAction(cfg());
    const res = await processStalePrNudges(testD1(), env);
    expect(res).toEqual({ nudged: 0 });
    expect(posts).toHaveLength(0);
  });

  it("窓外 (09:09) → 走らない", async () => {
    freezeJst(MON_YMD, "09:09");
    const { posts } = setupSlackSpy();
    stubGithub({ "ko-tarou/leaders-meetup-bot": [stalePr()] });
    await seedAction(cfg());
    const res = await processStalePrNudges(testD1(), env);
    expect(res).toEqual({ nudged: 0 });
    expect(posts).toHaveLength(0);
  });

  it("enabled=0 → 走らない", async () => {
    const { posts } = setupSlackSpy();
    stubGithub({ "ko-tarou/leaders-meetup-bot": [stalePr()] });
    await seedAction(cfg(), 0);
    const res = await processStalePrNudges(testD1(), env);
    expect(res).toEqual({ nudged: 0 });
    expect(posts).toHaveLength(0);
  });

  it("not-stale な PR は催促しない", async () => {
    const { posts } = setupSlackSpy();
    stubGithub({
      "ko-tarou/leaders-meetup-bot": [
        stalePr({ updated_at: "2026-05-18T08:30:00Z" }), // 30 分前 = not stale
      ],
    });
    await seedAction(cfg());
    const res = await processStalePrNudges(testD1(), env);
    expect(res).toEqual({ nudged: 0 });
    expect(posts).toHaveLength(0);
  });
});

describe("processStalePrNudges: 冪等 (dedup)", () => {
  it("同日 2 回実行 → 2 回目は dedupKey UNIQUE で skip (post は 1 回)", async () => {
    const { posts } = setupSlackSpy();
    stubGithub({ "ko-tarou/leaders-meetup-bot": [stalePr()] });
    await seedAction(cfg());
    const r1 = await processStalePrNudges(testD1(), env);
    const r2 = await processStalePrNudges(testD1(), env);
    expect(r1).toEqual({ nudged: 1 });
    expect(r2).toEqual({ nudged: 0 });
    expect(posts).toHaveLength(1);

    const jobs = await testDb().select().from(scheduledJobs).all();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("completed");
    expect(jobs[0].type).toBe("stale_pr_nudge_sent");
    expect(jobs[0].dedupKey).toBe(
      "stale_pr_nudge:ko-tarou/leaders-meetup-bot:42:20260518",
    );
  });
});

describe("processStalePrNudges: delete+repost (最新の 1 通だけ残す)", () => {
  it("(2) 翌日の実行は前回ダイジェストを削除してから新規投稿する", async () => {
    // ts/deletes を実行間で共有するため setupSlackSpy は 1 回だけ呼ぶ。
    const { posts, deletes } = setupSlackSpy();
    stubGithub({ "ko-tarou/leaders-meetup-bot": [stalePr()] });
    await seedAction(cfg());

    // Day1 (月): 初回投稿。前回 ts が無いので delete は起きない。
    freezeJst(MON_YMD, "09:00");
    const day1 = await processStalePrNudges(testD1(), env);
    expect(day1).toEqual({ nudged: 1 });
    expect(posts).toHaveLength(1);
    expect(deletes).toHaveLength(0);

    // Day2 (火): dedupKey の日付が変わり再 stale 判定。前回 ts ("1.0") を
    // 削除してから新規投稿する = チャンネルには常に最新 1 通だけ。
    freezeJst("2026-05-19", "09:00");
    const day2 = await processStalePrNudges(testD1(), env);
    expect(day2).toEqual({ nudged: 1 });
    expect(posts).toHaveLength(2);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toEqual({ channel: NUDGE_CHANNEL, ts: "1.0" });
  });

  it("同日 2 回目 (dedup skip) は前回を消さない (無駄な delete をしない)", async () => {
    const { posts, deletes } = setupSlackSpy();
    stubGithub({ "ko-tarou/leaders-meetup-bot": [stalePr()] });
    await seedAction(cfg());
    await processStalePrNudges(testD1(), env);
    await processStalePrNudges(testD1(), env);
    expect(posts).toHaveLength(1);
    expect(deletes).toHaveLength(0);
  });
});

describe("processStalePrNudges: fail-soft", () => {
  it("1 repo の取得失敗で他 repo は続行", async () => {
    const { posts } = setupSlackSpy();
    // fetch を repo ごとに分岐: 失敗 repo は 500、成功 repo は stale PR を返す。
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("bad/repo")) {
          return new Response("rate limited", { status: 403 });
        }
        return new Response(JSON.stringify([stalePr()]), { status: 200 });
      }),
    );
    await seedAction(
      cfg({ githubRepos: ["bad/repo", "ko-tarou/leaders-meetup-bot"] }),
    );
    const res = await processStalePrNudges(testD1(), env);
    expect(res).toEqual({ nudged: 1 });
    expect(posts).toHaveLength(1);
  });

  it("post 失敗 → job=failed・completed にならない (次回再挑戦可)", async () => {
    const failing = {
      postMessage: async () => {
        throw new Error("slack down");
      },
    };
    setSlackClientProvider(async () => failing as never);
    stubGithub({ "ko-tarou/leaders-meetup-bot": [stalePr()] });
    await seedAction(cfg());
    const res = await processStalePrNudges(testD1(), env);
    expect(res).toEqual({ nudged: 0 });
    const job = await testDb()
      .select()
      .from(scheduledJobs)
      .where(
        eq(
          scheduledJobs.dedupKey,
          "stale_pr_nudge:ko-tarou/leaders-meetup-bot:42:20260518",
        ),
      )
      .get();
    expect(job?.status).toBe("failed");
    expect(job?.lastError).toContain("slack down");
  });
});

// ============ 手動発火 (nudgeActionById) ============

describe("nudgeActionById: 手動発火", () => {
  it("窓外でも (平日/時間窓を無視して) 即発火する", async () => {
    freezeJst(MON_YMD, "15:30"); // nudgeTime=09:00 の窓外
    const { posts } = setupSlackSpy();
    stubGithub({ "ko-tarou/leaders-meetup-bot": [stalePr()] });
    const action = await seedAction(cfg());

    const res = await nudgeActionById(
      testD1(),
      env,
      action.eventId,
      action.id,
    );
    expect(res).toEqual({ ok: true, nudged: 1 });
    expect(posts).toHaveLength(1);
    expect(posts[0].channel).toBe(NUDGE_CHANNEL);
  });

  it("土曜 (週末) でも即発火する", async () => {
    freezeJst(SAT_YMD, "15:30");
    const { posts } = setupSlackSpy();
    stubGithub({ "ko-tarou/leaders-meetup-bot": [stalePr()] });
    const action = await seedAction(cfg());

    const res = await nudgeActionById(
      testD1(),
      env,
      action.eventId,
      action.id,
    );
    expect(res).toEqual({ ok: true, nudged: 1 });
    expect(posts).toHaveLength(1);
  });

  it("同日 dedup は維持: 2 回連打しても post は 1 回", async () => {
    const { posts } = setupSlackSpy();
    stubGithub({ "ko-tarou/leaders-meetup-bot": [stalePr()] });
    const action = await seedAction(cfg());

    const r1 = await nudgeActionById(testD1(), env, action.eventId, action.id);
    const r2 = await nudgeActionById(testD1(), env, action.eventId, action.id);
    expect(r1).toEqual({ ok: true, nudged: 1 });
    expect(r2).toEqual({ ok: true, nudged: 0 });
    expect(posts).toHaveLength(1);
  });

  it("cron が先に催促済みなら手動は二重投稿しない (dedup 整合)", async () => {
    const { posts } = setupSlackSpy();
    stubGithub({ "ko-tarou/leaders-meetup-bot": [stalePr()] });
    const action = await seedAction(cfg());

    // 平日窓内で cron が 1 回催促 (beforeEach で 09:00 に凍結済み)。
    const cron = await processStalePrNudges(testD1(), env);
    expect(cron).toEqual({ nudged: 1 });
    // 同日に手動発火 → 既に dedup 済みで投稿は増えない。
    const manual = await nudgeActionById(
      testD1(),
      env,
      action.eventId,
      action.id,
    );
    expect(manual).toEqual({ ok: true, nudged: 0 });
    expect(posts).toHaveLength(1);
  });

  it("action 不在 → action_not_found", async () => {
    setupSlackSpy();
    const action = await seedAction(cfg());
    const res = await nudgeActionById(testD1(), env, action.eventId, "nope");
    expect(res).toEqual({ ok: false, error: "action_not_found" });
  });

  it("eventId 不一致 → action_not_found (別イベントの action を叩けない)", async () => {
    setupSlackSpy();
    const action = await seedAction(cfg());
    const res = await nudgeActionById(testD1(), env, "wrong-event", action.id);
    expect(res).toEqual({ ok: false, error: "action_not_found" });
  });

  it("別 actionType → not_stale_pr_nudge", async () => {
    setupSlackSpy();
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, {
      actionType: "goal_reminder",
      config: cfg(),
    });
    const res = await nudgeActionById(testD1(), env, ev.id, action.id);
    expect(res).toEqual({ ok: false, error: "not_stale_pr_nudge" });
  });

  it("config 不正 (設定未完了) → invalid_config", async () => {
    setupSlackSpy();
    const action = await seedAction(
      JSON.stringify({ githubRepos: [] }), // 必須欠落 = parse null
    );
    const res = await nudgeActionById(
      testD1(),
      env,
      action.eventId,
      action.id,
    );
    expect(res).toEqual({ ok: false, error: "invalid_config" });
  });
});
