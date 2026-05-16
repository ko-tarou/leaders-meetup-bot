/**
 * 006-0-2 characterization: application-email。
 *
 * リファクタ前の現状の振る舞いを固定する回帰網。理想仕様ではなく、今の
 * `src/services/application-email.ts` の出力をそのまま期待値にする。
 * 本番コードは 1 行も変更しない (import のみ)。
 *
 * 固定対象:
 *  - readAutoSendConfig: 正常 / 不正 JSON / 欠損
 *  - resolveTemplateIdForTrigger: trigger 別解決 + 旧 templateId 後方互換
 *  - readEmailTemplates: 正常 / 型不正フィルタ / 不正 JSON
 *  - renderSlackInviteLinks: 新仕様(配列) / 旧仕様(単数) / 0件 / 1件 / 複数
 *  - getTriggerLabel / DEFAULT_LOG_TEMPLATE / DEFAULT_SUBJECT
 *  - sendApplicationEmailForTrigger / sendApplicationAutoEmail の分岐:
 *      trigger 種別ごとに gmail mock が「呼ばれる/呼ばれない」と引数、
 *      placeholder (name/email/meetLink/meetLinkLine/slackInviteLink/
 *      participationFormLink/interviewLocationLabel 等) の現状出力、
 *      テンプレ未設定デフォルト、fail-soft 経路、Slack ログ通知。
 *
 * モック方針: `gmail-send` と `slack-api` を vi.mock で差し替え、本番の
 * sendApplicationEmailForTrigger / createSlackClientForWorkspace パスを走らせる。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { MockSlackClient } from "../../mocks/slack";

type SentEmail = {
  gmailAccountId: string;
  to: string;
  subject: string;
  body: string;
  replyTo?: string;
};
const sentEmails: SentEmail[] = [];
let gmailShouldThrow: Error | null = null;

vi.mock("../../../src/services/gmail-send", () => ({
  GmailSendError: class extends Error {},
  sendGmailEmail: vi.fn(
    async (
      _env: unknown,
      gmailAccountId: string,
      params: { to: string; subject: string; body: string; replyTo?: string },
    ) => {
      if (gmailShouldThrow) {
        const e = gmailShouldThrow;
        gmailShouldThrow = null;
        throw e;
      }
      sentEmails.push({ gmailAccountId, ...params });
    },
  ),
}));

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
  readAutoSendConfig,
  resolveTemplateIdForTrigger,
  readEmailTemplates,
  renderSlackInviteLinks,
  readSlackInviteUrl,
  getTriggerLabel,
  DEFAULT_LOG_TEMPLATE,
  DEFAULT_SUBJECT,
  sendApplicationEmailForTrigger,
  sendApplicationAutoEmail,
  type AutoSendEmailConfig,
} from "../../../src/services/application-email";
import { makeEnv } from "../../helpers/env";
import { makeEncryptedWorkspace } from "../../helpers/factory";

const baseApp = {
  name: "応募 太郎",
  email: "applicant@example.com",
  appliedAt: "2026-05-17T00:00:00.000Z",
  studentId: "1EP1-1",
  howFound: "poster",
  interviewLocation: "online",
  interviewAt: null as string | null,
};

beforeEach(() => {
  sentEmails.length = 0;
  gmailShouldThrow = null;
  slackInstances.length = 0;
});

describe("readAutoSendConfig (現状固定)", () => {
  it("null / 空文字 / undefined は undefined", () => {
    expect(readAutoSendConfig(null)).toBeUndefined();
    expect(readAutoSendConfig("")).toBeUndefined();
    expect(readAutoSendConfig(undefined)).toBeUndefined();
  });

  it("不正 JSON は undefined", () => {
    expect(readAutoSendConfig("{bad")).toBeUndefined();
  });

  it("autoSendEmail キーが無ければ undefined", () => {
    expect(readAutoSendConfig(JSON.stringify({ x: 1 }))).toBeUndefined();
  });

  it("autoSendEmail をそのまま取り出す", () => {
    expect(
      readAutoSendConfig(
        JSON.stringify({
          autoSendEmail: { enabled: true, gmailAccountId: "g1" },
        }),
      ),
    ).toEqual({ enabled: true, gmailAccountId: "g1" });
  });
});

describe("resolveTemplateIdForTrigger (現状固定 + 後方互換)", () => {
  it("triggers に直接指定があればそれを返す", () => {
    const cfg: AutoSendEmailConfig = {
      triggers: { onSubmit: "t-sub", onPassed: "t-pass" },
    };
    expect(resolveTemplateIdForTrigger(cfg, "onSubmit")).toBe("t-sub");
    expect(resolveTemplateIdForTrigger(cfg, "onPassed")).toBe("t-pass");
  });

  it("triggers 未設定 + 旧 templateId は onSubmit にだけ fallback する", () => {
    // CHARACTERIZATION: 旧形式 templateId は応募完了時のみ送る従来挙動。
    const cfg: AutoSendEmailConfig = { templateId: "legacy-t" };
    expect(resolveTemplateIdForTrigger(cfg, "onSubmit")).toBe("legacy-t");
    expect(resolveTemplateIdForTrigger(cfg, "onScheduled")).toBeUndefined();
    expect(resolveTemplateIdForTrigger(cfg, "onPassed")).toBeUndefined();
    expect(resolveTemplateIdForTrigger(cfg, "onFailed")).toBeUndefined();
  });

  it("triggers に該当 key が無く onSubmit でもなければ undefined", () => {
    const cfg: AutoSendEmailConfig = { triggers: { onSubmit: "x" } };
    expect(resolveTemplateIdForTrigger(cfg, "onPassed")).toBeUndefined();
  });

  it("triggers.onSubmit が優先され、旧 templateId は無視される", () => {
    const cfg: AutoSendEmailConfig = {
      templateId: "legacy",
      triggers: { onSubmit: "new" },
    };
    expect(resolveTemplateIdForTrigger(cfg, "onSubmit")).toBe("new");
  });
});

describe("readEmailTemplates (現状固定)", () => {
  it("null / 不正 JSON / emailTemplates 非配列 は []", () => {
    expect(readEmailTemplates(null)).toEqual([]);
    expect(readEmailTemplates("{bad")).toEqual([]);
    expect(
      readEmailTemplates(JSON.stringify({ emailTemplates: "nope" })),
    ).toEqual([]);
  });

  it("id/name/body が string のものだけ通し、subject は string のみ採用", () => {
    const raw = JSON.stringify({
      emailTemplates: [
        { id: "1", name: "A", body: "B", subject: "S" },
        { id: "2", name: "no-subject", body: "B2" },
        { id: 3, name: "bad-id", body: "x" }, // 弾かれる
        { id: "4", name: "bad-subject", body: "x", subject: 99 }, // subject→undefined
        null,
      ],
    });
    expect(readEmailTemplates(raw)).toEqual([
      { id: "1", name: "A", body: "B", subject: "S" },
      { id: "2", name: "no-subject", body: "B2", subject: undefined },
      { id: "4", name: "bad-subject", body: "x", subject: undefined },
    ]);
  });
});

describe("renderSlackInviteLinks / readSlackInviteUrl (現状固定)", () => {
  it("null / 不正 JSON / 非オブジェクト は空文字", () => {
    expect(renderSlackInviteLinks(null)).toBe("");
    expect(renderSlackInviteLinks("{bad")).toBe("");
    expect(renderSlackInviteLinks("null")).toBe("");
  });

  it("旧仕様 slackInvite(単数) は url 単独で返す", () => {
    expect(
      renderSlackInviteLinks(
        JSON.stringify({ slackInvite: { name: "Main", url: "https://x" } }),
      ),
    ).toBe("https://x");
  });

  it("新仕様 slackInvites 配列: 1 件は url のみ (name 省略)", () => {
    expect(
      renderSlackInviteLinks(
        JSON.stringify({ slackInvites: [{ name: "A", url: "https://a" }] }),
      ),
    ).toBe("https://a");
  });

  it("新仕様 複数件は '- {name}: {url}' 改行区切り、name 無しは 'Slack'", () => {
    expect(
      renderSlackInviteLinks(
        JSON.stringify({
          slackInvites: [
            { name: "A", url: "https://a" },
            { url: "https://b" },
          ],
        }),
      ),
    ).toBe("- A: https://a\n- Slack: https://b");
  });

  it("url 欠損エントリは除外、全件 url 無しは空文字", () => {
    expect(
      renderSlackInviteLinks(
        JSON.stringify({ slackInvites: [{ name: "x" }, {}] }),
      ),
    ).toBe("");
  });

  it("readSlackInviteUrl は renderSlackInviteLinks の別名 (同出力)", () => {
    const cfg = JSON.stringify({ slackInvite: { url: "https://legacy" } });
    expect(readSlackInviteUrl(cfg)).toBe(renderSlackInviteLinks(cfg));
  });
});

describe("getTriggerLabel / 定数 (現状固定)", () => {
  it("trigger ラベルが現状のまま", () => {
    expect(getTriggerLabel("onSubmit")).toBe("応募完了時");
    expect(getTriggerLabel("onScheduled")).toBe("面接予定時");
    expect(getTriggerLabel("onPassed")).toBe("合格時");
    expect(getTriggerLabel("onFailed")).toBe("不合格時");
  });

  it("DEFAULT_SUBJECT / DEFAULT_LOG_TEMPLATE が現状のまま", () => {
    expect(DEFAULT_SUBJECT).toBe("ご応募ありがとうございます");
    expect(DEFAULT_LOG_TEMPLATE).toBe(
      "{mentions} 📧 自動メール送信ログ\nトリガー: {triggerLabel}\n宛先: {recipientName} <{to}>\n件名: {subject}\nテンプレート: {templateName}",
    );
  });
});

describe("sendApplicationEmailForTrigger 分岐 (現状固定)", () => {
  function cfg(
    over: Partial<AutoSendEmailConfig> = {},
    templates: unknown[] = [],
    extra: Record<string, unknown> = {},
  ): string {
    return JSON.stringify({
      autoSendEmail: { enabled: true, gmailAccountId: "g1", ...over },
      emailTemplates: templates,
      ...extra,
    });
  }

  it("config 無し → gmail 未送信 (no-op)", async () => {
    await sendApplicationEmailForTrigger(makeEnv(), null, baseApp, "onSubmit");
    expect(sentEmails).toHaveLength(0);
  });

  it("enabled=false → 送信しない", async () => {
    await sendApplicationEmailForTrigger(
      makeEnv(),
      cfg({ enabled: false }),
      baseApp,
      "onSubmit",
    );
    expect(sentEmails).toHaveLength(0);
  });

  it("gmailAccountId 欠損 → 送信しない", async () => {
    await sendApplicationEmailForTrigger(
      makeEnv(),
      cfg({ gmailAccountId: undefined }),
      baseApp,
      "onSubmit",
    );
    expect(sentEmails).toHaveLength(0);
  });

  it("application.email 空 → 送信しない", async () => {
    await sendApplicationEmailForTrigger(
      makeEnv(),
      cfg({ triggers: { onSubmit: "t" } }, [{ id: "t", name: "N", body: "B" }]),
      { ...baseApp, email: "" },
      "onSubmit",
    );
    expect(sentEmails).toHaveLength(0);
  });

  it("trigger に対応する templateId が無い → 送信しない", async () => {
    await sendApplicationEmailForTrigger(
      makeEnv(),
      cfg({ triggers: { onSubmit: "t" } }, [{ id: "t", name: "N", body: "B" }]),
      baseApp,
      "onPassed",
    );
    expect(sentEmails).toHaveLength(0);
  });

  it("templateId はあるが該当 template が無い → 送信しない", async () => {
    await sendApplicationEmailForTrigger(
      makeEnv(),
      cfg({ triggers: { onSubmit: "missing" } }, [
        { id: "other", name: "N", body: "B" },
      ]),
      baseApp,
      "onSubmit",
    );
    expect(sentEmails).toHaveLength(0);
  });

  it("正常系: placeholder 全種が現状の値で展開され送信される", async () => {
    const body = [
      "name={name}",
      "email={email}",
      "appliedAt={appliedAt}",
      "studentId={studentId}",
      "howFound={howFound}",
      "interviewLocation={interviewLocation}",
      "interviewLocationLabel={interviewLocationLabel}",
      "interviewAt={interviewAt}",
      "meetLink={meetLink}",
      "meetLinkLine={meetLinkLine}",
      "slackInviteLink={slackInviteLink}",
      "participationFormLink={participationFormLink}",
    ].join("\n");
    await sendApplicationEmailForTrigger(
      makeEnv(),
      cfg(
        { triggers: { onPassed: "tpl" } },
        [{ id: "tpl", name: "合格", subject: "件名 {name}", body }],
        { slackInvites: [{ url: "https://invite" }] },
      ),
      {
        ...baseApp,
        interviewAt: "2026-05-20T05:00:00.000Z",
        meetLink: "https://meet.example/abc",
        participationFormLink: "https://form/p?t=xyz",
      },
      "onPassed",
    );
    expect(sentEmails).toHaveLength(1);
    const sent = sentEmails[0];
    expect(sent.gmailAccountId).toBe("g1");
    expect(sent.to).toBe("applicant@example.com");
    expect(sent.subject).toBe("件名 応募 太郎");
    // CHARACTERIZATION: appliedAt/interviewAt は JST 変換、
    // interviewLocationLabel は "online" → "オンライン (Google Meet)"、
    // meetLinkLine は meetLink ありで "Meet リンク: <URL>"。
    expect(sent.body).toBe(
      [
        "name=応募 太郎",
        "email=applicant@example.com",
        "appliedAt=2026-05-17 09:00",
        "studentId=1EP1-1",
        "howFound=poster",
        "interviewLocation=online",
        "interviewLocationLabel=オンライン (Google Meet)",
        "interviewAt=2026-05-20 14:00",
        "meetLink=https://meet.example/abc",
        "meetLinkLine=Meet リンク: https://meet.example/abc",
        "slackInviteLink=https://invite",
        "participationFormLink=https://form/p?t=xyz",
      ].join("\n"),
    );
  });

  it("meetLink 未設定: meetLink/meetLinkLine は空文字、lab206 ラベル変換", async () => {
    await sendApplicationEmailForTrigger(
      makeEnv(),
      cfg({ triggers: { onScheduled: "t" } }, [
        {
          id: "t",
          name: "予定",
          body: "loc={interviewLocationLabel}|line=[{meetLinkLine}]|meet=[{meetLink}]",
        },
      ]),
      { ...baseApp, interviewLocation: "lab206" },
      "onScheduled",
    );
    // CHARACTERIZATION: lab206 → "11号館 lab206"、meetLink 無しで line/meet 空。
    expect(sentEmails[0].body).toBe(
      "loc=11号館 lab206|line=[]|meet=[]",
    );
  });

  it("未知 interviewLocation はラベル変換されず raw 値が出る", async () => {
    await sendApplicationEmailForTrigger(
      makeEnv(),
      cfg({ triggers: { onSubmit: "t" } }, [
        { id: "t", name: "N", body: "{interviewLocationLabel}" },
      ]),
      { ...baseApp, interviewLocation: "unknown_loc" },
      "onSubmit",
    );
    expect(sentEmails[0].body).toBe("unknown_loc");
  });

  it("subject 未設定 / 空白テンプレ → DEFAULT_SUBJECT が使われる", async () => {
    await sendApplicationEmailForTrigger(
      makeEnv(),
      cfg({ triggers: { onSubmit: "t" } }, [
        { id: "t", name: "N", body: "x", subject: "   " },
      ]),
      baseApp,
      "onSubmit",
    );
    expect(sentEmails[0].subject).toBe(DEFAULT_SUBJECT);
  });

  it("replyToEmail が空白なら replyTo 未設定、値ありなら trim して渡す", async () => {
    await sendApplicationEmailForTrigger(
      makeEnv(),
      cfg({ triggers: { onSubmit: "t" }, replyToEmail: "  " }, [
        { id: "t", name: "N", body: "x" },
      ]),
      baseApp,
      "onSubmit",
    );
    expect(sentEmails[0].replyTo).toBeUndefined();
    sentEmails.length = 0;
    await sendApplicationEmailForTrigger(
      makeEnv(),
      cfg({ triggers: { onSubmit: "t" }, replyToEmail: " r@x.com " }, [
        { id: "t", name: "N", body: "x" },
      ]),
      baseApp,
      "onSubmit",
    );
    expect(sentEmails[0].replyTo).toBe("r@x.com");
  });

  it("fail-soft: gmail send が throw しても sendApplicationEmailForTrigger は throw しない", async () => {
    gmailShouldThrow = new Error("gmail down");
    await expect(
      sendApplicationEmailForTrigger(
        makeEnv(),
        cfg({ triggers: { onSubmit: "t" } }, [
          { id: "t", name: "N", body: "x" },
        ]),
        baseApp,
        "onSubmit",
      ),
    ).resolves.toBeUndefined();
  });

  it("logToSlack 有効: 送信成功時に Slack ログを 1 回 post (DEFAULT_LOG_TEMPLATE 展開)", async () => {
    const { row } = await makeEncryptedWorkspace();
    await sendApplicationEmailForTrigger(
      makeEnv(),
      cfg(
        {
          triggers: { onPassed: "t" },
          logToSlack: {
            enabled: true,
            workspaceId: row.id,
            channelId: "C-LOG",
            mentionUserIds: ["U9"],
          },
        },
        [{ id: "t", name: "合格テンプレ", subject: "S", body: "B" }],
      ),
      baseApp,
      "onPassed",
    );
    expect(sentEmails).toHaveLength(1);
    expect(slackInstances).toHaveLength(1);
    const [channel, text] = slackInstances[0].callsOf("postMessage")[0]
      .args as [string, string];
    expect(channel).toBe("C-LOG");
    expect(text).toBe(
      "<@U9> 📧 自動メール送信ログ\nトリガー: 合格時\n宛先: 応募 太郎 <applicant@example.com>\n件名: S\nテンプレート: 合格テンプレ",
    );
  });

  it("logToSlack enabled=false → Slack ログは送らない (メール送信は成功)", async () => {
    await sendApplicationEmailForTrigger(
      makeEnv(),
      cfg(
        {
          triggers: { onSubmit: "t" },
          logToSlack: {
            enabled: false,
            workspaceId: "w",
            channelId: "C",
            mentionUserIds: [],
          },
        },
        [{ id: "t", name: "N", body: "x" }],
      ),
      baseApp,
      "onSubmit",
    );
    expect(sentEmails).toHaveLength(1);
    expect(slackInstances).toHaveLength(0);
  });

  it("Slack ログ用 workspace が不在でもメール送信成功は変わらない (fail-soft)", async () => {
    await sendApplicationEmailForTrigger(
      makeEnv(),
      cfg(
        {
          triggers: { onSubmit: "t" },
          logToSlack: {
            enabled: true,
            workspaceId: "ghost-ws",
            channelId: "C",
            mentionUserIds: [],
          },
        },
        [{ id: "t", name: "N", body: "x" }],
      ),
      baseApp,
      "onSubmit",
    );
    expect(sentEmails).toHaveLength(1);
    expect(slackInstances).toHaveLength(0);
  });
});

describe("sendApplicationAutoEmail (onSubmit ラッパ, 現状固定)", () => {
  it("内部的に onSubmit trigger として送る", async () => {
    await sendApplicationAutoEmail(
      makeEnv(),
      JSON.stringify({
        autoSendEmail: {
          enabled: true,
          gmailAccountId: "g1",
          triggers: { onSubmit: "t" },
        },
        emailTemplates: [{ id: "t", name: "完了", subject: "S", body: "本文" }],
      }),
      baseApp,
    );
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].body).toBe("本文");
  });

  it("onSubmit trigger が解決できなければ送らない", async () => {
    await sendApplicationAutoEmail(
      makeEnv(),
      JSON.stringify({
        autoSendEmail: {
          enabled: true,
          gmailAccountId: "g1",
          triggers: { onPassed: "t" },
        },
        emailTemplates: [{ id: "t", name: "N", body: "x" }],
      }),
      baseApp,
    );
    expect(sentEmails).toHaveLength(0);
  });
});
