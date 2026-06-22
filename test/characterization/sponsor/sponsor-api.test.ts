/**
 * sponsor_application API (D1 + mock, integration)。
 *
 * 隔離 D1 (miniflare, 本番非接触) に event/eventAction を seed し、
 * `sponsorRouter` をテスト用 Hono app にマウントして実リクエストを投げ、
 * 公開フォーム (申込 / メール確認) と admin CRUD の挙動を固定する。
 *
 * 検証対象:
 *  - POST /sponsor/:eventId : 必須/金額バリデーション / 作成後 DB (unconfirmed) /
 *    通知 + 確認メール hook / rate-limit (同一 email 連投 429)
 *  - GET /sponsor/:eventId/event : 最小情報 + enabled
 *  - GET /sponsor/:eventId/confirm : token で unconfirmed→pending 昇格 / 冪等
 *  - GET /orgs/:eventId/sponsor-applications : unconfirmed 除外 / includeUnconfirmed
 *  - PUT /sponsor-applications/:id : approve/reject 遷移 + お礼/見送りメール
 *  - DELETE /sponsor-applications/:id
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { MockSlackClient } from "../../mocks/slack";

type SentEmail = {
  gmailAccountId: string;
  to: string;
  subject: string;
  body: string;
  replyTo?: string;
};
const sentEmails: SentEmail[] = [];
vi.mock("../../../src/services/gmail-send", () => ({
  GmailSendError: class extends Error {},
  sendGmailEmail: vi.fn(
    async (
      _e: unknown,
      gmailAccountId: string,
      p: { to: string; subject: string; body: string; replyTo?: string },
    ) => {
      sentEmails.push({ gmailAccountId, ...p });
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

import { sponsorRouter } from "../../../src/routes/api/sponsor";
import { makeEnv } from "../../helpers/env";
import { testDb } from "../../helpers/db";
import { sponsorApplications } from "../../../src/db/schema";
import { eq } from "drizzle-orm";
import {
  makeEvent,
  makeEventAction,
  makeEncryptedWorkspace,
} from "../../helpers/factory";

function app() {
  const a = new Hono<{ Bindings: ReturnType<typeof makeEnv> }>();
  a.route("/", sponsorRouter);
  return a;
}

const env = makeEnv();

function jsonReq(path: string, method: string, body?: unknown) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  // resetSeq は呼ばない: D1 storage はファイル内で永続するため id を毎テスト
  // ユニークにする必要がある (連番カウンタを進め続ける)。
  sentEmails.length = 0;
  slackInstances.length = 0;
});

// 個人スポンサー (0065) の新フォーム body。お名前(name) / 所属(affiliation) /
// 応援メッセージ(message) を主項目に。
const validBody = {
  name: "山田 太郎",
  affiliation: "○○大学",
  email: "sponsor@example.com",
  amount: 50000,
  message: "応援しています！",
};

// 後方互換: 旧フォーム (企業前提) の body も BE は受け付ける。
const legacyBody = {
  companyName: "テスト株式会社",
  contactName: "担当 太郎",
  email: "legacy@example.com",
  amount: 30000,
  period: "単発",
  purpose: "学生支援",
};

describe("POST /sponsor/:eventId", () => {
  it("作成すると 201 + status=unconfirmed で永続化される", async () => {
    const ev = await makeEvent();
    await makeEventAction(ev.id, { actionType: "sponsor_application" });

    const res = await app().request(jsonReq(`/sponsor/${ev.id}`, "POST", validBody), {}, env);
    expect(res.status).toBe(201);
    const json = (await res.json()) as { ok: boolean; id: string };
    expect(json.ok).toBe(true);

    const row = await testDb()
      .select()
      .from(sponsorApplications)
      .where(eq(sponsorApplications.id, json.id))
      .get();
    expect(row?.status).toBe("unconfirmed");
    // 個人化 0065: name は companyName 列に格納され、contactName も同値になる。
    expect(row?.companyName).toBe("山田 太郎");
    expect(row?.contactName).toBe("山田 太郎");
    expect(row?.affiliation).toBe("○○大学");
    expect(row?.message).toBe("応援しています！");
    // 個人スポンサーは一律 5000 円固定 (0069)。送信値 50000 は無視される。
    expect(row?.amount).toBe(5000);
    expect(row?.confirmToken).toBeTruthy();
  });

  it("旧フォーム (企業前提) の body も後方互換で受け付ける", async () => {
    const ev = await makeEvent();
    await makeEventAction(ev.id, { actionType: "sponsor_application" });

    const res = await app().request(
      jsonReq(`/sponsor/${ev.id}`, "POST", legacyBody),
      {},
      env,
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { id: string };
    const row = await testDb()
      .select()
      .from(sponsorApplications)
      .where(eq(sponsorApplications.id, json.id))
      .get();
    // companyName をお名前として保持し、旧 period/purpose も残る。
    expect(row?.companyName).toBe("テスト株式会社");
    expect(row?.contactName).toBe("担当 太郎");
    expect(row?.period).toBe("単発");
    expect(row?.purpose).toBe("学生支援");
  });

  it("必須欠落 / 不正 email は 400 (金額は固定なので検証しない)", async () => {
    const ev = await makeEvent();
    await makeEventAction(ev.id, { actionType: "sponsor_application" });
    const a = app();

    const noName = await a.request(
      jsonReq(`/sponsor/${ev.id}`, "POST", { ...validBody, name: "" }),
      {},
      env,
    );
    expect(noName.status).toBe(400);

    const badEmail = await a.request(
      jsonReq(`/sponsor/${ev.id}`, "POST", { ...validBody, email: "nope" }),
      {},
      env,
    );
    expect(badEmail.status).toBe(400);

    // 金額入力は廃止 (一律 5000)。不正金額を送っても 5000 で受理される (0069)。
    const badAmount = await a.request(
      jsonReq(`/sponsor/${ev.id}`, "POST", { ...validBody, amount: 0 }),
      {},
      env,
    );
    expect(badAmount.status).toBe(201);
  });

  it("当日来場アンケートを保存する / 範囲外は null (0069)", async () => {
    const ev = await makeEvent();
    await makeEventAction(ev.id, { actionType: "sponsor_application" });
    const a = app();

    const ok = await a.request(
      jsonReq(`/sponsor/${ev.id}`, "POST", {
        ...validBody,
        attendanceOnDay: "coming",
      }),
      {},
      env,
    );
    expect(ok.status).toBe(201);
    const okId = ((await ok.json()) as { id: string }).id;
    const okRow = await testDb()
      .select()
      .from(sponsorApplications)
      .where(eq(sponsorApplications.id, okId))
      .get();
    expect(okRow?.attendanceOnDay).toBe("coming");

    const bad = await a.request(
      jsonReq(`/sponsor/${ev.id}`, "POST", {
        ...validBody,
        email: "another@example.com",
        attendanceOnDay: "maybe",
      }),
      {},
      env,
    );
    expect(bad.status).toBe(201);
    const badId = ((await bad.json()) as { id: string }).id;
    const badRow = await testDb()
      .select()
      .from(sponsorApplications)
      .where(eq(sponsorApplications.id, badId))
      .get();
    expect(badRow?.attendanceOnDay).toBeNull();
  });

  it("存在しない event は 404", async () => {
    const res = await app().request(
      jsonReq(`/sponsor/nope/`.replace(/\/$/, ""), "POST", validBody),
      {},
      env,
    );
    expect(res.status).toBe(404);
  });

  it("同一 email を連続で投げると 2 回目は 429 (rate-limit)", async () => {
    const ev = await makeEvent();
    await makeEventAction(ev.id, { actionType: "sponsor_application" });
    const a = app();

    const r1 = await a.request(jsonReq(`/sponsor/${ev.id}`, "POST", validBody), {}, env);
    expect(r1.status).toBe(201);
    const r2 = await a.request(jsonReq(`/sponsor/${ev.id}`, "POST", validBody), {}, env);
    expect(r2.status).toBe(429);
  });

  it("通知 + 確認メールが送られる (notifications / autoSendEmail 設定時)", async () => {
    const ev = await makeEvent();
    const { row: ws } = await makeEncryptedWorkspace();
    const config = JSON.stringify({
      notifications: {
        enabled: true,
        workspaceId: ws.id,
        channelId: "C123",
        mentionUserIds: [],
      },
      autoSendEmail: {
        enabled: true,
        gmailAccountId: "gmail-1",
        triggers: { onSubmit: "tpl-confirm" },
      },
      emailTemplates: [
        {
          id: "tpl-confirm",
          name: "受付確認",
          subject: "ご申込ありがとうございます",
          body: "{name} 様\n所属: {affiliation}\n金額: {amount} 円\n確認: {confirmUrl}",
        },
      ],
    });
    await makeEventAction(ev.id, { actionType: "sponsor_application", config });

    const res = await app().request(jsonReq(`/sponsor/${ev.id}`, "POST", validBody), {}, env);
    expect(res.status).toBe(201);

    // Slack 通知 1 件
    expect(slackInstances.length).toBe(1);
    expect(slackInstances[0].callsOf("postMessage").length).toBe(1);
    // 確認メール 1 件 (confirmUrl が body に埋まる)
    expect(sentEmails.length).toBe(1);
    expect(sentEmails[0].to).toBe("sponsor@example.com");
    // 個人化 0065: {name} {affiliation} placeholder が埋まる。
    expect(sentEmails[0].body).toContain("山田 太郎 様");
    expect(sentEmails[0].body).toContain("所属: ○○大学");
    // confirm リンクは /api 配下 (SPA fallback に吸われないため必須)。
    expect(sentEmails[0].body).toContain("/api/sponsor/");
    expect(sentEmails[0].body).toContain("/confirm?t=");
  });
});

describe("GET /sponsor/:eventId/event", () => {
  it("最小情報 + enabled を返す", async () => {
    const ev = await makeEvent({ name: "HackIT" });
    await makeEventAction(ev.id, { actionType: "sponsor_application", enabled: 1 });
    const res = await app().request(new Request(`http://localhost/sponsor/${ev.id}/event`), {}, env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { id: string; name: string; enabled: boolean };
    expect(json.name).toBe("HackIT");
    expect(json.enabled).toBe(true);
  });

  it("action 無しなら enabled=false", async () => {
    const ev = await makeEvent();
    const res = await app().request(new Request(`http://localhost/sponsor/${ev.id}/event`), {}, env);
    const json = (await res.json()) as { enabled: boolean };
    expect(json.enabled).toBe(false);
  });
});

describe("GET /sponsor/:eventId/confirm", () => {
  it("正しい token で unconfirmed→pending に昇格し、再訪も冪等", async () => {
    const ev = await makeEvent();
    await makeEventAction(ev.id, { actionType: "sponsor_application" });
    const a = app();
    const create = await a.request(jsonReq(`/sponsor/${ev.id}`, "POST", validBody), {}, env);
    const { id } = (await create.json()) as { id: string };
    const row = await testDb()
      .select()
      .from(sponsorApplications)
      .where(eq(sponsorApplications.id, id))
      .get();
    const token = row!.confirmToken!;

    const c1 = await a.request(
      new Request(`http://localhost/sponsor/${ev.id}/confirm?t=${token}`),
      {},
      env,
    );
    expect(c1.status).toBe(200);
    const after = await testDb()
      .select()
      .from(sponsorApplications)
      .where(eq(sponsorApplications.id, id))
      .get();
    expect(after?.status).toBe("pending");
    expect(after?.confirmedAt).toBeTruthy();

    // 再訪も 200 (冪等)
    const c2 = await a.request(
      new Request(`http://localhost/sponsor/${ev.id}/confirm?t=${token}`),
      {},
      env,
    );
    expect(c2.status).toBe(200);
  });

  it("不正 token は 404", async () => {
    const ev = await makeEvent();
    const res = await app().request(
      new Request(`http://localhost/sponsor/${ev.id}/confirm?t=bad`),
      {},
      env,
    );
    expect(res.status).toBe(404);
  });
});

describe("admin list / update / delete", () => {
  it("一覧はデフォルトで unconfirmed を除外、includeUnconfirmed=1 で含める", async () => {
    const ev = await makeEvent();
    await makeEventAction(ev.id, { actionType: "sponsor_application" });
    const a = app();
    // unconfirmed を 1 件作成
    await a.request(jsonReq(`/sponsor/${ev.id}`, "POST", validBody), {}, env);

    const def = await a.request(
      new Request(`http://localhost/orgs/${ev.id}/sponsor-applications`),
      {},
      env,
    );
    expect(((await def.json()) as unknown[]).length).toBe(0);

    const inc = await a.request(
      new Request(`http://localhost/orgs/${ev.id}/sponsor-applications?includeUnconfirmed=1`),
      {},
      env,
    );
    expect(((await inc.json()) as unknown[]).length).toBe(1);
  });

  it("approve に更新するとお礼メールが送られ status=approved", async () => {
    const ev = await makeEvent();
    const config = JSON.stringify({
      autoSendEmail: {
        enabled: true,
        gmailAccountId: "gmail-1",
        triggers: { onPassed: "tpl-thanks" },
      },
      emailTemplates: [
        { id: "tpl-thanks", name: "お礼", subject: "ご協賛ありがとうございます", body: "{companyName} 様" },
      ],
    });
    await makeEventAction(ev.id, { actionType: "sponsor_application", config });
    const a = app();
    const create = await a.request(jsonReq(`/sponsor/${ev.id}`, "POST", validBody), {}, env);
    const { id } = (await create.json()) as { id: string };
    sentEmails.length = 0;

    const res = await a.request(
      jsonReq(`/sponsor-applications/${id}`, "PUT", { status: "approved" }),
      {},
      env,
    );
    expect(res.status).toBe(200);
    const updated = (await res.json()) as { status: string; decidedAt: string };
    expect(updated.status).toBe("approved");
    expect(updated.decidedAt).toBeTruthy();
    expect(sentEmails.length).toBe(1);
  });

  it("DELETE で行が消える", async () => {
    const ev = await makeEvent();
    await makeEventAction(ev.id, { actionType: "sponsor_application" });
    const a = app();
    const create = await a.request(jsonReq(`/sponsor/${ev.id}`, "POST", validBody), {}, env);
    const { id } = (await create.json()) as { id: string };

    const del = await a.request(jsonReq(`/sponsor-applications/${id}`, "DELETE"), {}, env);
    expect(del.status).toBe(200);
    const gone = await a.request(
      new Request(`http://localhost/sponsor-applications/${id}`),
      {},
      env,
    );
    expect(gone.status).toBe(404);
  });
});
