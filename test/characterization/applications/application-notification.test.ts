/**
 * 006-0-2 characterization: application-notification（pure / 準pure）。
 *
 * リファクタ前の **現状の振る舞いを "あるがまま" 固定する** 回帰網。
 * 理想仕様ではなく、今の `src/services/application-notification.ts` が返す値を
 * そのまま期待値にする。本番コードは 1 行も変更しない (import のみ)。
 *
 * 固定対象:
 *  - renderTemplate: placeholder 置換 (既知 / 未知 / 空 / {mentions} 連結)
 *  - readNotificationsConfig: 正常 / 不正 JSON / 欠損
 *  - DEFAULT_TEMPLATE: デフォルト文面そのもの
 *  - sendApplicationNotification: fail-soft
 *      (disabled / workspace 不在 / postMessage 失敗 でも throw しない、
 *       Slack mock の呼ばれ方を記録検証)
 *
 * モック方針: `slack-api` を `vi.mock` で MockSlackClient に差し替え、
 * 本番の `createSlackClientForWorkspace`(decryptToken 経由) パスをそのまま走らせる。
 * D1 = miniflare 隔離 (本番非接触)。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { MockSlackClient } from "../../mocks/slack";

// slack-api モジュール全体を差し替え。SlackClient を生成する箇所
// (workspace.createSlackClientForWorkspace) はこのクラスを new する。
const slackInstances: MockSlackClient[] = [];
vi.mock("../../../src/services/slack-api", () => ({
  SlackClient: class {
    constructor() {
      const m = new MockSlackClient();
      slackInstances.push(m);
      return m as unknown as object;
    }
  },
}));

import {
  renderTemplate,
  readNotificationsConfig,
  sendApplicationNotification,
  DEFAULT_TEMPLATE,
} from "../../../src/services/application-notification";
import { makeEnv } from "../../helpers/env";
import { makeEncryptedWorkspace } from "../../helpers/factory";

function lastSlack(): MockSlackClient {
  return slackInstances[slackInstances.length - 1];
}

// resetSeq() は呼ばない: D1 storage はファイル単位で永続するため、seq を
// リセットすると workspaces.slack_team_id (UNIQUE) が衝突する。連番を
// ファイル内で単調増加させることで各 workspace を一意にする。
beforeEach(() => {
  slackInstances.length = 0;
});

describe("renderTemplate (現状固定)", () => {
  it("既知 placeholder を vars で置換する", () => {
    expect(
      renderTemplate("hi {name} <{email}>", {
        name: "太郎",
        email: "t@example.com",
      }),
    ).toBe("hi 太郎 <t@example.com>");
  });

  it("未定義 placeholder はそのまま {unknown} で残す", () => {
    // CHARACTERIZATION: 未知キーは置換せず原文保持。Phase2 でも維持予定だが要確認。
    expect(renderTemplate("{known} {unknown}", { known: "X" })).toBe(
      "X {unknown}",
    );
  });

  it("vars が空でもテンプレ原文を返す", () => {
    expect(renderTemplate("plain text", {})).toBe("plain text");
  });

  it("値が空文字の placeholder は空文字に置換 (placeholder が消える)", () => {
    expect(renderTemplate("a{x}b", { x: "" })).toBe("ab");
  });

  it("同一 placeholder が複数回出ても全て置換する", () => {
    expect(renderTemplate("{n} {n} {n}", { n: "Q" })).toBe("Q Q Q");
  });

  it("正規表現は \\w+ のみ一致: ハイフン/ドットを含むキーは未置換", () => {
    // CHARACTERIZATION: /\{(\w+)\}/ なので {a-b} や {a.b} は対象外で原文保持。
    expect(renderTemplate("{a-b} {a.b} {valid}", { valid: "V" })).toBe(
      "{a-b} {a.b} V",
    );
  });
});

describe("readNotificationsConfig (現状固定)", () => {
  it("不正 JSON は undefined", () => {
    expect(readNotificationsConfig("{not json")).toBeUndefined();
  });

  it("null / 空文字 は undefined", () => {
    expect(readNotificationsConfig(null)).toBeUndefined();
    expect(readNotificationsConfig(undefined)).toBeUndefined();
    expect(readNotificationsConfig("")).toBeUndefined();
  });

  it("notifications キーが無い JSON は undefined", () => {
    expect(readNotificationsConfig(JSON.stringify({ other: 1 }))).toBeUndefined();
  });

  it("notifications オブジェクトをそのまま取り出す", () => {
    expect(
      readNotificationsConfig(
        JSON.stringify({
          notifications: { enabled: true, channelId: "C1", workspaceId: "W1" },
        }),
      ),
    ).toEqual({ enabled: true, channelId: "C1", workspaceId: "W1" });
  });
});

describe("DEFAULT_TEMPLATE (現状文面を固定)", () => {
  it("デフォルト文面が現状のまま", () => {
    expect(DEFAULT_TEMPLATE).toBe(
      "{mentions} 新しい応募がありました\n名前: {name}\nメール: {email}\n応募日時: {appliedAt} (JST)",
    );
  });

  it("mentions 空 + render すると先頭がスペース始まりになり trim で消える", () => {
    // CHARACTERIZATION: sendApplicationNotification は .trim() してから post する。
    // mentions 未設定だと "{mentions} 新しい..." の先頭スペースが trim で除去される。
    const rendered = renderTemplate(DEFAULT_TEMPLATE, {
      mentions: "",
      name: "太郎",
      email: "t@example.com",
      appliedAt: "2026-05-17 09:00",
    }).trim();
    expect(rendered).toBe(
      "新しい応募がありました\n名前: 太郎\nメール: t@example.com\n応募日時: 2026-05-17 09:00 (JST)",
    );
  });
});

describe("sendApplicationNotification fail-soft / 呼び出し記録 (現状固定)", () => {
  const application = {
    name: "応募 太郎",
    email: "applicant@example.com",
    appliedAt: "2026-05-17T00:00:00.000Z",
    studentId: "1EP1-1",
    howFound: "poster",
    interviewLocation: "online",
    interviewAt: null,
  };

  it("config が無い (undefined) → no-op、Slack 未呼び出し、throw しない", async () => {
    await expect(
      sendApplicationNotification(makeEnv(), undefined, application),
    ).resolves.toBeUndefined();
    expect(slackInstances).toHaveLength(0);
  });

  it("enabled でない → no-op (Slack 未生成)", async () => {
    const cfg = JSON.stringify({
      notifications: { enabled: false, workspaceId: "w", channelId: "C1" },
    });
    await sendApplicationNotification(makeEnv(), cfg, application);
    expect(slackInstances).toHaveLength(0);
  });

  it("enabled だが workspaceId / channelId 欠損 → no-op", async () => {
    const cfg = JSON.stringify({
      notifications: { enabled: true, channelId: "C1" },
    });
    await sendApplicationNotification(makeEnv(), cfg, application);
    expect(slackInstances).toHaveLength(0);
  });

  it("workspace が DB に存在しない → no-op (createSlackClient が null)、throw しない", async () => {
    const cfg = JSON.stringify({
      notifications: {
        enabled: true,
        workspaceId: "nonexistent-ws",
        channelId: "C1",
      },
    });
    await expect(
      sendApplicationNotification(makeEnv(), cfg, application),
    ).resolves.toBeUndefined();
    // createSlackClientForWorkspace は workspace 不在で null → SlackClient 未生成
    expect(slackInstances).toHaveLength(0);
  });

  it("正常系: postMessage が DEFAULT_TEMPLATE (mention 連結) で 1 回呼ばれる", async () => {
    const { row } = await makeEncryptedWorkspace();
    const cfg = JSON.stringify({
      notifications: {
        enabled: true,
        workspaceId: row.id,
        channelId: "C-NOTIFY",
        mentionUserIds: ["U1", "U2"],
      },
    });
    await sendApplicationNotification(makeEnv(), cfg, application);

    expect(slackInstances).toHaveLength(1);
    const calls = lastSlack().callsOf("postMessage");
    expect(calls).toHaveLength(1);
    const [channel, text] = calls[0].args as [string, string];
    expect(channel).toBe("C-NOTIFY");
    // CHARACTERIZATION: appliedAt は utcToJstFormat で JST 変換される
    // (2026-05-17T00:00:00Z → 2026-05-17 09:00)。
    expect(text).toBe(
      "<@U1> <@U2> 新しい応募がありました\n名前: 応募 太郎\nメール: applicant@example.com\n応募日時: 2026-05-17 09:00 (JST)",
    );
  });

  it("messageTemplate 指定時はそのテンプレで render (studentId/howFound 等の placeholder)", async () => {
    const { row } = await makeEncryptedWorkspace();
    const cfg = JSON.stringify({
      notifications: {
        enabled: true,
        workspaceId: row.id,
        channelId: "C-T",
        messageTemplate:
          "応募者={name} 学籍={studentId} きっかけ={howFound} 場所={interviewLocation} 面接={interviewAt}",
      },
    });
    await sendApplicationNotification(makeEnv(), cfg, application);
    const [, text] = lastSlack().callsOf("postMessage")[0].args as [
      string,
      string,
    ];
    // CHARACTERIZATION: interviewAt null は空文字、howFound は raw 値 ("poster") のまま。
    expect(text).toBe(
      "応募者=応募 太郎 学籍=1EP1-1 きっかけ=poster 場所=online 面接=",
    );
  });

  it("postMessage が ok:false を返しても throw しない (fail-soft, log のみ)", async () => {
    const { row } = await makeEncryptedWorkspace();
    const cfg = JSON.stringify({
      notifications: {
        enabled: true,
        workspaceId: row.id,
        channelId: "C-FAIL",
      },
    });
    const spy = vi
      .spyOn(MockSlackClient.prototype, "postMessage")
      .mockResolvedValueOnce({ ok: false, error: "channel_not_found" });
    await expect(
      sendApplicationNotification(makeEnv(), cfg, application),
    ).resolves.toBeUndefined();
    // CHARACTERIZATION: ok:false でも例外を投げず log のみ。応募 API を落とさない。
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("postMessage が throw しても sendApplicationNotification は throw しない", async () => {
    const { row } = await makeEncryptedWorkspace();
    const cfg = JSON.stringify({
      notifications: {
        enabled: true,
        workspaceId: row.id,
        channelId: "C-THROW",
      },
    });
    // SlackClient 生成を待ってから failure を仕込むため、prototype を patch する。
    const spy = vi
      .spyOn(MockSlackClient.prototype, "postMessage")
      .mockRejectedValueOnce(new Error("network down"));
    await expect(
      sendApplicationNotification(makeEnv(), cfg, application),
    ).resolves.toBeUndefined();
    spy.mockRestore();
  });
});
