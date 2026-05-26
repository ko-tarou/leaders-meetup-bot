/**
 * 朝勉強会けじめ制度 PR15: buildStatusBlocks の吊し上げメンション +
 * kejime-article-flow.ts の通知文面テンプレ rendering の characterization.
 *
 * - todayLateSlackUserIds 0 件 / 1 件 / 複数件
 * - renderArticleTemplate: placeholder 置換
 * - parseTracker: messageTemplates が config から読まれる
 * - processQiitaArticleSubmission: domain 拒否文言が config テンプレで上書きされる
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  buildStatusBlocks,
} from "../../../src/services/kejime-status-post";
import {
  renderArticleTemplate, processQiitaArticleSubmission,
  DEFAULT_REJECTED_DOMAIN_TEMPLATE,
} from "../../../src/services/kejime-article-flow";
import { testD1, testDb } from "../../helpers/db";
import { makeEvent, makeEventAction } from "../../helpers/factory";
import {
  eventActions, kejimeArticleRequests, kejimeEvents, kejimeMembers,
} from "../../../src/db/schema";
import { MockSlackClient } from "../../mocks/slack";

function text(blocks: Array<Record<string, unknown>>): string {
  const sec = blocks[0] as { text?: { text?: string } };
  return sec.text?.text ?? "";
}

describe("PR15: buildStatusBlocks 吊し上げメンション", () => {
  it("todayLateSlackUserIds 未指定 → メンションセクションは出ない", () => {
    const blocks = buildStatusBlocks(
      [{ displayName: "山田", currentPoints: 1, ramenCount: 0 }],
      [], "2026-05-19 (火)",
    );
    expect(text(blocks)).not.toContain("本日のけじめ対象");
    expect(text(blocks)).not.toContain("rotating_light");
  });

  it("0 件 → メンションセクションは出ない", () => {
    const blocks = buildStatusBlocks(
      [{ displayName: "山田", currentPoints: 1, ramenCount: 0 }],
      [], "2026-05-19 (火)", undefined, [],
    );
    expect(text(blocks)).not.toContain("本日のけじめ対象");
  });

  it("1 件 → <@U1> 形式でメンションする", () => {
    const blocks = buildStatusBlocks(
      [{ displayName: "山田", currentPoints: 1, ramenCount: 0 }],
      [], "2026-05-19 (火)", undefined, ["U-LATE1"],
    );
    const t = text(blocks);
    expect(t).toContain("本日のけじめ対象");
    expect(t).toContain("<@U-LATE1>");
  });

  it("複数件 → スペース区切りで全員メンション", () => {
    const blocks = buildStatusBlocks(
      [], [], "2026-05-19 (火)", undefined, ["U-A", "U-B", "U-C"],
    );
    const t = text(blocks);
    expect(t).toContain("<@U-A> <@U-B> <@U-C>");
  });
});

describe("PR15: renderArticleTemplate (pure)", () => {
  it("placeholder 全種を置換する", () => {
    const out = renderArticleTemplate(
      "🎉 <@{user}> ({length}/{minLength}) → {newPoints}pt {url}",
      { user: "U1", length: 100, minLength: 500, newPoints: 4, url: "https://x" },
    );
    expect(out).toBe("🎉 <@U1> (100/500) → 4pt https://x");
  });

  it("欠落 placeholder は空文字に置換", () => {
    const out = renderArticleTemplate("a {user} b {length} c", { user: "U1" });
    expect(out).toBe("a U1 b  c");
  });

  it("placeholder が無いテンプレもそのまま返す", () => {
    expect(renderArticleTemplate("hello", {})).toBe("hello");
  });
});

const KEJIME_CH = "C-KEJIME";
const VALID_ID = "0123456789abcdef0123";
const QIITA_URL = `https://qiita.com/foo/items/${VALID_ID}`;

function fetchOk(length: number): typeof globalThis.fetch {
  return (async () => new Response(JSON.stringify({ body: "x".repeat(length) }), {
    status: 200, headers: { "content-type": "application/json" },
  })) as unknown as typeof globalThis.fetch;
}

beforeEach(async () => {
  const db = testDb();
  await db.delete(kejimeArticleRequests);
  await db.delete(kejimeEvents);
  await db.delete(kejimeMembers);
  await db.delete(eventActions);
});

describe("PR15: messageTemplates が config から適用される", () => {
  it("rejectedDomain がカスタム文言で post される", async () => {
    const ev = await makeEvent();
    const tracker = await makeEventAction(ev.id, {
      actionType: "kejime_tracker",
      config: JSON.stringify({
        schemaVersion: 1, kejimeChannelId: KEJIME_CH, roleId: "role-x",
        messageTemplates: {
          rejectedDomain: "⚠️ <@{user}> Qiita だけだよ！",
        },
      }),
    });
    const slack = new MockSlackClient();
    await processQiitaArticleSubmission(testD1(), slack, fetchOk(600), {
      actionId: tracker.id, slackUserId: "U-ALICE", url: "https://example.com/post",
    });
    const calls = slack.callsOf("postMessage");
    expect(calls).toHaveLength(1);
    const [, msg] = calls[0].args as [string, string];
    // notice 自体にカスタム文言が乗る (上流で <@user> prefix も付くが、template
    // 内の {user} が置換されるので "Qiita だけだよ！" が含まれる)。
    expect(msg).toContain("Qiita だけだよ！");
    expect(msg).toContain("<@U-ALICE>");
  });

  it("rejectedShort のテンプレ未指定 → default 文言", async () => {
    const ev = await makeEvent();
    const tracker = await makeEventAction(ev.id, {
      actionType: "kejime_tracker",
      config: JSON.stringify({
        schemaVersion: 1, kejimeChannelId: KEJIME_CH, roleId: "role-x",
        minArticleLength: 500,
      }),
    });
    const slack = new MockSlackClient();
    await processQiitaArticleSubmission(testD1(), slack, fetchOk(100), {
      actionId: tracker.id, slackUserId: "U-BOB", url: QIITA_URL,
    });
    const [, msg] = slack.callsOf("postMessage")[0].args as [string, string];
    // default 文言 (100文字 / 必要 500文字)
    expect(msg).toContain("100文字");
    expect(msg).toContain("500文字");
  });

  it("空文字テンプレは default にフォールバック", async () => {
    const ev = await makeEvent();
    const tracker = await makeEventAction(ev.id, {
      actionType: "kejime_tracker",
      config: JSON.stringify({
        schemaVersion: 1, kejimeChannelId: KEJIME_CH, roleId: "role-x",
        messageTemplates: { rejectedDomain: "" },
      }),
    });
    const slack = new MockSlackClient();
    await processQiitaArticleSubmission(testD1(), slack, fetchOk(600), {
      actionId: tracker.id, slackUserId: "U-C", url: "https://example.com/post",
    });
    const [, msg] = slack.callsOf("postMessage")[0].args as [string, string];
    // default の "Qiita 記事 URL のみ受け付けています。" が含まれる
    expect(msg).toContain(DEFAULT_REJECTED_DOMAIN_TEMPLATE);
  });
});
