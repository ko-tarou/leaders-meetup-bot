/**
 * 宗教イベント PR2 characterization: whitelist 公開フォーム API。
 *
 * 隔離 D1 (miniflare, 本番非接触) に event/eventAction/whitelistMember を seed し、
 * `whitelistPublicRouter` をテスト用 Hono app にマウントして実リクエストを投げる。
 *
 * 固定対象:
 *  - POST → GET roundtrip: 正しい token で同じ名前リストが返る。
 *  - 保存時暗号化: whitelist_entries.name_encrypted は平文と一致しない。
 *  - token プライバシー: 不明な token は 404。他人のリストは引けない。
 *  - バリデーション: 件数超過 / 文字数超過 / 非配列は 400。
 *
 * 注: router を "/" 直下にマウントするため admin auth (api.ts 側) は適用されない。
 * /whitelist/* は本来 adminAuth 除外パスなので、route ハンドラ自体の挙動を固定する。
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";

import { whitelistPublicRouter } from "../../../src/routes/api/whitelist-public";
import { makeEnv } from "../../helpers/env";
import { testDb } from "../../helpers/db";
import { whitelistMembers, whitelistEntries } from "../../../src/db/schema";
import { eq } from "drizzle-orm";
import { makeEvent, makeEventAction } from "../../helpers/factory";

function app() {
  const a = new Hono<{ Bindings: ReturnType<typeof makeEnv> }>();
  a.route("/", whitelistPublicRouter);
  return a;
}

const env = makeEnv();

let memberSeq = 0;

/**
 * whitelist_members 行を直接 seed して token を得る。
 * event / eventAction を作ってから (event_action_id, slack_user_id) UNIQUE を満たす。
 */
async function seedMember(over: { token?: string; displayName?: string } = {}) {
  const ev = await makeEvent({ type: "whitelist" });
  const action = await makeEventAction(ev.id, { actionType: "whitelist" });
  const db = testDb();
  const id = `wm-${memberSeq}`;
  const token = over.token ?? `tok-${memberSeq}-${"a".repeat(32)}`;
  memberSeq += 1;
  await db.insert(whitelistMembers).values({
    id,
    eventActionId: action.id,
    slackUserId: `U${memberSeq}`,
    displayName: over.displayName ?? "メンバー 太郎",
    token,
    submittedAt: null,
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:00:00.000Z",
  });
  return { memberId: id, token, eventActionId: action.id };
}

async function post(token: string, body: unknown) {
  return app().request(
    `/whitelist/${token}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

async function get(token: string) {
  return app().request(`/whitelist/${token}`, {}, env);
}

describe("whitelist 公開フォーム API (現状固定)", () => {
  it("POST → GET roundtrip で同じ名前リストが返る", async () => {
    const { token } = await seedMember({ displayName: "山田 花子" });

    const postRes = await post(token, { names: ["田中 一郎", "佐藤 次郎"] });
    expect(postRes.status).toBe(200);
    expect(await postRes.json()).toEqual({ ok: true, count: 2 });

    const getRes = await get(token);
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual({
      displayName: "山田 花子",
      names: ["田中 一郎", "佐藤 次郎"],
    });
  });

  it("空文字 / 前後空白は除去され count に含まれない", async () => {
    const { token } = await seedMember();
    const res = await post(token, { names: ["  鈴木  ", "", "   "] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, count: 1 });

    const getRes = await get(token);
    expect(await getRes.json()).toMatchObject({ names: ["鈴木"] });
  });

  it("再 POST すると entries は全置換される (idempotent)", async () => {
    const { token } = await seedMember();
    await post(token, { names: ["最初の人"] });
    await post(token, { names: ["別の人", "もう一人"] });

    const getRes = await get(token);
    expect(await getRes.json()).toMatchObject({
      names: ["別の人", "もう一人"],
    });
  });

  it("保存される name_encrypted は平文と一致しない (保存時暗号化)", async () => {
    const { token, memberId } = await seedMember();
    const plaintext = "暗号化される名前";
    await post(token, { names: [plaintext] });

    const db = testDb();
    const rows = await db
      .select()
      .from(whitelistEntries)
      .where(eq(whitelistEntries.memberId, memberId))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].nameEncrypted).not.toBe(plaintext);
    expect(rows[0].nameEncrypted).not.toContain(plaintext);
    // crypto.ts の形式 "{iv}:{ct}:{tag}" であること。
    expect(rows[0].nameEncrypted.split(":")).toHaveLength(3);
  });

  it("提出後に submittedAt / updatedAt が更新される", async () => {
    const { token, memberId } = await seedMember();
    await post(token, { names: ["誰か"] });

    const db = testDb();
    const m = await db
      .select()
      .from(whitelistMembers)
      .where(eq(whitelistMembers.id, memberId))
      .get();
    expect(m?.submittedAt).not.toBeNull();
    expect(m?.updatedAt).not.toBe("2026-05-28T00:00:00.000Z");
  });

  it("不明な token は 404 で、他人のリストを引けない", async () => {
    const { token } = await seedMember();
    await post(token, { names: ["本人の秘密リスト"] });

    const getRes = await get("unknown-token");
    expect(getRes.status).toBe(404);
    expect(await getRes.json()).toEqual({ error: "invalid_token" });

    const postRes = await post("unknown-token", { names: ["x"] });
    expect(postRes.status).toBe(404);
  });

  it("別メンバーの token では自分の entries しか見えない", async () => {
    const a = await seedMember({ displayName: "A" });
    const b = await seedMember({ displayName: "B" });
    await post(a.token, { names: ["Aの人"] });
    await post(b.token, { names: ["Bの人"] });

    expect(await (await get(a.token)).json()).toEqual({
      displayName: "A",
      names: ["Aの人"],
    });
    expect(await (await get(b.token)).json()).toEqual({
      displayName: "B",
      names: ["Bの人"],
    });
  });

  it("件数が 50 を超えると 400", async () => {
    const { token } = await seedMember();
    const names = Array.from({ length: 51 }, (_, i) => `n${i}`);
    const res = await post(token, { names });
    expect(res.status).toBe(400);
  });

  it("1 件が 100 文字を超えると 400", async () => {
    const { token } = await seedMember();
    const res = await post(token, { names: ["x".repeat(101)] });
    expect(res.status).toBe(400);
  });

  it("names が配列でないと 400", async () => {
    const { token } = await seedMember();
    const res = await post(token, { names: "not-an-array" });
    expect(res.status).toBe(400);
  });

  it("names の要素が文字列でないと 400", async () => {
    const { token } = await seedMember();
    const res = await post(token, { names: [123] });
    expect(res.status).toBe(400);
  });
});
