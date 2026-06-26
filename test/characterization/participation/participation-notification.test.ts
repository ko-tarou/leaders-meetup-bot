/**
 * 006-0-3 characterization: participation-notification (準pure + D1)。
 *
 * リファクタ前の **現状の振る舞いを "あるがまま" 固定する** 回帰網。
 * 理想仕様ではなく、今の `src/services/participation-notification.ts` が返す/
 * post する値をそのまま期待値にする。本番コードは 1 行も変更しない (import のみ)。
 *
 * 固定対象:
 *  - DEFAULT_PARTICIPATION_TEMPLATE / DEFAULT_PARTICIPATION_UNRESOLVED_TEMPLATE
 *      の文面
 *  - readParticipationNotificationsConfig: 正常 / 不正 / 欠損
 *  - sendParticipationNotification: configKey=participationNotifications 解決、
 *      vars 展開、デフォルト/カスタムテンプレ、mention 連結
 *  - sendParticipationUnresolvedNotification: configKey=
 *      participationUnresolvedNotifications 解決
 *  - fail-soft: disabled / ws 不在 / postMessage ok:false / throw でも
 *      提出を落とさない (throw しない)、Slack mock の呼ばれ方を記録検証
 *
 * モック方針: `slack-api` を MockSlackClient に差し替え、本番の
 * createSlackClientForWorkspace(decryptToken 経由) パスをそのまま走らせる。
 * D1 = miniflare 隔離 (本番非接触)。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { MockSlackClient } from "../../mocks/slack";

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
  sendParticipationNotification,
  sendParticipationUnresolvedNotification,
  readParticipationNotificationsConfig,
  DEFAULT_PARTICIPATION_TEMPLATE,
  DEFAULT_PARTICIPATION_UNRESOLVED_TEMPLATE,
  type ParticipationFormLike,
} from "../../../src/services/participation-notification";
import { makeEnv } from "../../helpers/env";
import { makeEncryptedWorkspace } from "../../helpers/factory";

function lastSlack(): MockSlackClient {
  return slackInstances[slackInstances.length - 1];
}

const form: ParticipationFormLike = {
  name: "参加 太郎",
  email: "p@example.com",
  submittedAt: "2026-05-17T00:00:00.000Z",
  // 参加届フリガナ欄 (migration 0071)。デフォルトテンプレに {nameKana} 行を追加。
  nameKana: "サンカ タロウ",
  slackName: "taro",
  studentId: "1EP1-1",
  department: "情報",
  grade: "3",
  gender: "male",
  desiredActivity: "dev",
  otherAffiliations: "サークルB",
  devRoles: ["pm", "frontend"],
};

beforeEach(() => {
  slackInstances.length = 0;
});

describe("デフォルトテンプレ文面 (現状固定)", () => {
  it("DEFAULT_PARTICIPATION_TEMPLATE が現状のまま", () => {
    expect(DEFAULT_PARTICIPATION_TEMPLATE).toBe(
      "{mentions} 📋 参加届が提出されました\n名前: {name}\nフリガナ: {nameKana}\nSlack表示名: {slackName}\nメール: {email}\n希望活動: {desiredActivity}",
    );
  });

  it("DEFAULT_PARTICIPATION_UNRESOLVED_TEMPLATE が現状のまま", () => {
    expect(DEFAULT_PARTICIPATION_UNRESOLVED_TEMPLATE).toBe(
      "{mentions} ⚠️ 参加届の Slack 表示名が見つかりませんでした\n名前: {name}\nフリガナ: {nameKana}\nSlack表示名: {slackName}\nメール: {email}\n希望活動: {desiredActivity}\n手動でのロール紐付けが必要です（参加届タブ）",
    );
  });
});

describe("readParticipationNotificationsConfig (現状固定)", () => {
  it("null / 空 / 不正 JSON → undefined", () => {
    expect(readParticipationNotificationsConfig(null)).toBeUndefined();
    expect(readParticipationNotificationsConfig("")).toBeUndefined();
    expect(readParticipationNotificationsConfig("{bad")).toBeUndefined();
  });

  it("participationNotifications キー欠損 → undefined", () => {
    expect(
      readParticipationNotificationsConfig(JSON.stringify({ other: 1 })),
    ).toBeUndefined();
  });

  it("participationNotifications オブジェクトをそのまま返す", () => {
    expect(
      readParticipationNotificationsConfig(
        JSON.stringify({
          participationNotifications: {
            enabled: true,
            workspaceId: "W1",
            channelId: "C1",
          },
        }),
      ),
    ).toEqual({ enabled: true, workspaceId: "W1", channelId: "C1" });
  });
});

describe("sendParticipationNotification fail-soft / no-op (現状固定)", () => {
  it("config 無し → no-op、Slack 未生成、throw しない", async () => {
    await expect(
      sendParticipationNotification(makeEnv(), undefined, form),
    ).resolves.toBeUndefined();
    expect(slackInstances).toHaveLength(0);
  });

  it("enabled でない → no-op", async () => {
    const cfg = JSON.stringify({
      participationNotifications: {
        enabled: false,
        workspaceId: "w",
        channelId: "C1",
      },
    });
    await sendParticipationNotification(makeEnv(), cfg, form);
    expect(slackInstances).toHaveLength(0);
  });

  it("workspaceId / channelId 欠損 → no-op", async () => {
    const cfg = JSON.stringify({
      participationNotifications: { enabled: true, channelId: "C1" },
    });
    await sendParticipationNotification(makeEnv(), cfg, form);
    expect(slackInstances).toHaveLength(0);
  });

  it("workspace が DB に存在しない → no-op (throw しない)", async () => {
    const cfg = JSON.stringify({
      participationNotifications: {
        enabled: true,
        workspaceId: "ghost-ws",
        channelId: "C1",
      },
    });
    await expect(
      sendParticipationNotification(makeEnv(), cfg, form),
    ).resolves.toBeUndefined();
    expect(slackInstances).toHaveLength(0);
  });

  it("postMessage が ok:false → throw しない (log のみ)", async () => {
    const { row } = await makeEncryptedWorkspace();
    const cfg = JSON.stringify({
      participationNotifications: {
        enabled: true,
        workspaceId: row.id,
        channelId: "C-FAIL",
      },
    });
    const spy = vi
      .spyOn(MockSlackClient.prototype, "postMessage")
      .mockResolvedValueOnce({ ok: false, error: "channel_not_found" });
    await expect(
      sendParticipationNotification(makeEnv(), cfg, form),
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("postMessage が throw → catch して throw しない", async () => {
    const { row } = await makeEncryptedWorkspace();
    const cfg = JSON.stringify({
      participationNotifications: {
        enabled: true,
        workspaceId: row.id,
        channelId: "C-THROW",
      },
    });
    const spy = vi
      .spyOn(MockSlackClient.prototype, "postMessage")
      .mockRejectedValueOnce(new Error("network down"));
    await expect(
      sendParticipationNotification(makeEnv(), cfg, form),
    ).resolves.toBeUndefined();
    spy.mockRestore();
  });
});

describe("sendParticipationNotification 文面 (現状固定)", () => {
  it("デフォルトテンプレ + mention 連結 + JST 変換", async () => {
    const { row } = await makeEncryptedWorkspace();
    const cfg = JSON.stringify({
      participationNotifications: {
        enabled: true,
        workspaceId: row.id,
        channelId: "C-N",
        mentionUserIds: ["U1", "U2"],
      },
    });
    await sendParticipationNotification(makeEnv(), cfg, form);
    expect(slackInstances).toHaveLength(1);
    const calls = lastSlack().callsOf("postMessage");
    expect(calls).toHaveLength(1);
    const [channel, text] = calls[0].args as [string, string];
    expect(channel).toBe("C-N");
    // CHARACTERIZATION: デフォルトテンプレに mentions/name/slackName/email/
    // desiredActivity のみ展開。submittedAt は出ない (テンプレに placeholder 無)。
    expect(text).toBe(
      "<@U1> <@U2> 📋 参加届が提出されました\n名前: 参加 太郎\nフリガナ: サンカ タロウ\nSlack表示名: taro\nメール: p@example.com\n希望活動: dev",
    );
  });

  it("mention 空 → 先頭スペースが trim で消える", async () => {
    const { row } = await makeEncryptedWorkspace();
    const cfg = JSON.stringify({
      participationNotifications: {
        enabled: true,
        workspaceId: row.id,
        channelId: "C-N",
      },
    });
    await sendParticipationNotification(makeEnv(), cfg, form);
    const [, text] = lastSlack().callsOf("postMessage")[0].args as [
      string,
      string,
    ];
    // CHARACTERIZATION: text は .trim() してから post。mentions 空で先頭空白除去。
    expect(text.startsWith("📋")).toBe(true);
  });

  it("messageTemplate 指定時はそのテンプレで全 vars 展開 (submittedAt は JST)", async () => {
    const { row } = await makeEncryptedWorkspace();
    const cfg = JSON.stringify({
      participationNotifications: {
        enabled: true,
        workspaceId: row.id,
        channelId: "C-T",
        messageTemplate:
          "学籍={studentId} 学科={department} 学年={grade} 性別={gender} 他={otherAffiliations} dev={devRoles} 提出={submittedAt}",
      },
    });
    await sendParticipationNotification(makeEnv(), cfg, form);
    const [, text] = lastSlack().callsOf("postMessage")[0].args as [
      string,
      string,
    ];
    // CHARACTERIZATION: devRoles は ", " join、submittedAt は utcToJstFormat
    // (2026-05-17T00:00:00Z → 2026-05-17 09:00)。
    expect(text).toBe(
      "学籍=1EP1-1 学科=情報 学年=3 性別=male 他=サークルB dev=pm, frontend 提出=2026-05-17 09:00",
    );
  });

  it("空白のみ messageTemplate はデフォルトテンプレにフォールバック", async () => {
    const { row } = await makeEncryptedWorkspace();
    const cfg = JSON.stringify({
      participationNotifications: {
        enabled: true,
        workspaceId: row.id,
        channelId: "C-T",
        messageTemplate: "   ",
      },
    });
    await sendParticipationNotification(makeEnv(), cfg, form);
    const [, text] = lastSlack().callsOf("postMessage")[0].args as [
      string,
      string,
    ];
    // CHARACTERIZATION: messageTemplate?.trim() が falsy ならデフォルト使用。
    expect(text).toContain("📋 参加届が提出されました");
  });

  it("null フィールドは空文字に置換される (slackName/desiredActivity null)", async () => {
    const { row } = await makeEncryptedWorkspace();
    const cfg = JSON.stringify({
      participationNotifications: {
        enabled: true,
        workspaceId: row.id,
        channelId: "C-T",
      },
    });
    await sendParticipationNotification(makeEnv(), cfg, {
      ...form,
      slackName: null,
      desiredActivity: null,
    });
    const [, text] = lastSlack().callsOf("postMessage")[0].args as [
      string,
      string,
    ];
    // CHARACTERIZATION: text は .trim() されるため末尾 "希望活動: " の
    // 行末スペースが除去され "希望活動:" で終わる。
    expect(text).toBe(
      "📋 参加届が提出されました\n名前: 参加 太郎\nフリガナ: サンカ タロウ\nSlack表示名: \nメール: p@example.com\n希望活動:",
    );
  });
});

describe("sendParticipationUnresolvedNotification (現状固定)", () => {
  it("participationUnresolvedNotifications キーを解決 (participationNotifications では発火しない)", async () => {
    const { row } = await makeEncryptedWorkspace();
    // participationNotifications のみ設定 → unresolved は no-op
    const cfgOnlyNormal = JSON.stringify({
      participationNotifications: {
        enabled: true,
        workspaceId: row.id,
        channelId: "C-N",
      },
    });
    await sendParticipationUnresolvedNotification(
      makeEnv(),
      cfgOnlyNormal,
      form,
    );
    expect(slackInstances).toHaveLength(0);
  });

  it("unresolved 用デフォルトテンプレで post される", async () => {
    const { row } = await makeEncryptedWorkspace();
    const cfg = JSON.stringify({
      participationUnresolvedNotifications: {
        enabled: true,
        workspaceId: row.id,
        channelId: "C-U",
        mentionUserIds: ["UADMIN"],
      },
    });
    await sendParticipationUnresolvedNotification(makeEnv(), cfg, form);
    const [channel, text] = lastSlack().callsOf("postMessage")[0].args as [
      string,
      string,
    ];
    expect(channel).toBe("C-U");
    expect(text).toBe(
      "<@UADMIN> ⚠️ 参加届の Slack 表示名が見つかりませんでした\n名前: 参加 太郎\nフリガナ: サンカ タロウ\nSlack表示名: taro\nメール: p@example.com\n希望活動: dev\n手動でのロール紐付けが必要です（参加届タブ）",
    );
  });

  it("unresolved 通知も fail-soft (postMessage throw でも throw しない)", async () => {
    const { row } = await makeEncryptedWorkspace();
    const cfg = JSON.stringify({
      participationUnresolvedNotifications: {
        enabled: true,
        workspaceId: row.id,
        channelId: "C-U",
      },
    });
    const spy = vi
      .spyOn(MockSlackClient.prototype, "postMessage")
      .mockRejectedValueOnce(new Error("boom"));
    await expect(
      sendParticipationUnresolvedNotification(makeEnv(), cfg, form),
    ).resolves.toBeUndefined();
    spy.mockRestore();
  });
});
