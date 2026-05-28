/**
 * 宗教イベント PR4: checkConsensus (全会一致検出 + Slack 通知) characterization.
 *
 * 隔離 D1 (miniflare, 本番非接触) に event/eventAction(whitelist)/role/
 * slackRoleMembers/whitelistMembers/whitelistEntries を seed し、`checkConsensus`
 * を直接呼ぶ。Slack は `setSlackClientProvider` で fake client に差し替え、
 * postMessage の呼び出しを記録する (実 Slack には一切接続しない)。
 *
 * entries は本番と同じ `encryptToken` で暗号化保存し、checkConsensus 内の
 * 復号 (decryptToken) → normalizeName のパスをそのまま動かす。
 *
 * 固定対象:
 *  - 全員提出 + 共通名 → whitelist_unanimous に 1 row INSERT + Slack 通知 1 回
 *    (channel = notifyChannelId, text に共通名を含む)。
 *  - 未提出 (or whitelistMembers row 欠落) → INSERT なし / 通知なし (保留)。
 *  - 既に whitelist_unanimous に存在する名前 → 再通知しない (二重防止)。
 *  - 全員に共通する名前が無い → 通知なし。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";

import { checkConsensus } from "../../../src/services/whitelist-consensus";
import {
  setSlackClientProvider,
  resetSlackClientProvider,
} from "../../../src/services/workspace";
import { encryptToken } from "../../../src/services/crypto";
import { testDb } from "../../helpers/db";
import { makeEnv } from "../../helpers/env";
import {
  makeEvent,
  makeEventAction,
  makeEncryptedWorkspace,
  makeSlackRole,
  makeSlackRoleMember,
} from "../../helpers/factory";
import {
  whitelistMembers,
  whitelistEntries,
  whitelistUnanimous,
} from "../../../src/db/schema";

const env = makeEnv();

/** fake Slack client。postMessage の (channel, text, blocks) を記録する。 */
type PostCall = { channel: string; text: string };
function setupSlackSpy(): { posts: PostCall[] } {
  const posts: PostCall[] = [];
  const fake = {
    postMessage: async (channel: string, text: string) => {
      posts.push({ channel, text });
      return { ok: true, ts: "1.0" };
    },
  };
  setSlackClientProvider(async () => fake as never);
  return { posts };
}

let memberSeq = 0;

/** whitelist action + role を seed し、config に workspace/role/notifyChannel を入れる。 */
async function setup() {
  const { row: ws } = await makeEncryptedWorkspace();
  const ev = await makeEvent();
  const roleAction = await makeEventAction(ev.id, {
    actionType: "role_management",
    config: JSON.stringify({ workspaceId: ws.id }),
  });
  const role = await makeSlackRole(roleAction.id);
  const action = await makeEventAction(ev.id, {
    actionType: "whitelist",
    config: JSON.stringify({
      workspaceId: ws.id,
      roleId: role.id,
      notifyChannelId: "C-NOTIFY",
    }),
  });
  return { ev, action, role };
}

/**
 * role メンバー + (submitted な) whitelist_members + 暗号化済み entries を seed する。
 *  - submitted=false なら submittedAt=null (未提出)。
 *  - names が undefined なら whitelist_members 行自体を作らない (row 欠落ケース)。
 */
async function seedMember(
  actionId: string,
  roleId: string,
  slackUserId: string,
  opts: { names?: string[]; submitted?: boolean } = {},
) {
  const db = testDb();
  await makeSlackRoleMember(roleId, slackUserId);
  if (opts.names === undefined && opts.submitted === undefined) return;

  const id = `wm-pr4-${memberSeq++}`;
  await db.insert(whitelistMembers).values({
    id,
    eventActionId: actionId,
    slackUserId,
    displayName: slackUserId,
    token: `tok-pr4-${memberSeq}-${"a".repeat(20)}`,
    submittedAt: opts.submitted === false ? null : "2026-05-28T00:00:00.000Z",
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:00:00.000Z",
  });
  for (const name of opts.names ?? []) {
    await db.insert(whitelistEntries).values({
      id: crypto.randomUUID(),
      memberId: id,
      nameEncrypted: await encryptToken(name, env.WORKSPACE_TOKEN_KEY),
      createdAt: "2026-05-28T00:00:00.000Z",
    });
  }
}

async function unanimousRows(actionId: string) {
  return testDb()
    .select()
    .from(whitelistUnanimous)
    .where(eq(whitelistUnanimous.eventActionId, actionId))
    .all();
}

beforeEach(async () => {
  const db = testDb();
  await db.delete(whitelistEntries);
  await db.delete(whitelistMembers);
  await db.delete(whitelistUnanimous);
});

afterEach(() => {
  resetSlackClientProvider();
});

describe("checkConsensus (全会一致検出 + 通知)", () => {
  it("全員提出 + 共通名 → unanimous 1 row + Slack 通知 1 回", async () => {
    const { action, role } = await setup();
    const { posts } = setupSlackSpy();
    await seedMember(action.id, role.id, "U1", {
      names: ["田中 太郎", "山田 花子"],
    });
    await seedMember(action.id, role.id, "U2", {
      names: ["田中　太郎", "佐藤 次郎"], // 全角空白 → 正規化で "田中 太郎" に一致
    });

    await checkConsensus(testDb(), action.id, env);

    const rows = await unanimousRows(action.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].nameNormalized).toBe("田中 太郎");

    expect(posts).toHaveLength(1);
    expect(posts[0].channel).toBe("C-NOTIFY");
    expect(posts[0].text).toBe(
      "🤝 全会一致：全員が「田中 太郎」を希望しています。誘いましょう。",
    );
  });

  it("1 人が未提出 (submittedAt null) → INSERT も通知もしない (保留)", async () => {
    const { action, role } = await setup();
    const { posts } = setupSlackSpy();
    await seedMember(action.id, role.id, "U1", { names: ["田中 太郎"] });
    await seedMember(action.id, role.id, "U2", {
      names: ["田中 太郎"],
      submitted: false,
    });

    await checkConsensus(testDb(), action.id, env);

    expect(await unanimousRows(action.id)).toHaveLength(0);
    expect(posts).toHaveLength(0);
  });

  it("role メンバーの whitelist_members 行が無い → INSERT も通知もしない", async () => {
    const { action, role } = await setup();
    const { posts } = setupSlackSpy();
    await seedMember(action.id, role.id, "U1", { names: ["田中 太郎"] });
    // U2 は role メンバーだが whitelist_members 行を作らない (names 未指定)。
    await seedMember(action.id, role.id, "U2");

    await checkConsensus(testDb(), action.id, env);

    expect(await unanimousRows(action.id)).toHaveLength(0);
    expect(posts).toHaveLength(0);
  });

  it("既に unanimous に存在する名前 → 再通知しない (二重防止)", async () => {
    const { action, role } = await setup();
    const { posts } = setupSlackSpy();
    await seedMember(action.id, role.id, "U1", { names: ["田中 太郎"] });
    await seedMember(action.id, role.id, "U2", { names: ["田中 太郎"] });

    // 既に通知済みの行を先に入れておく。
    await testDb()
      .insert(whitelistUnanimous)
      .values({
        id: "wu-existing",
        eventActionId: action.id,
        nameNormalized: "田中 太郎",
        notifiedAt: "2026-05-27T00:00:00.000Z",
      });

    await checkConsensus(testDb(), action.id, env);

    // 行は 1 件のまま (新規 INSERT されない)、通知も飛ばない。
    const rows = await unanimousRows(action.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("wu-existing");
    expect(posts).toHaveLength(0);
  });

  it("全員に共通する名前が無い → 通知しない", async () => {
    const { action, role } = await setup();
    const { posts } = setupSlackSpy();
    await seedMember(action.id, role.id, "U1", { names: ["田中 太郎"] });
    await seedMember(action.id, role.id, "U2", { names: ["佐藤 次郎"] });

    await checkConsensus(testDb(), action.id, env);

    expect(await unanimousRows(action.id)).toHaveLength(0);
    expect(posts).toHaveLength(0);
  });

  it("role メンバーが空 → 何もしない", async () => {
    const { action } = await setup();
    const { posts } = setupSlackSpy();

    await checkConsensus(testDb(), action.id, env);

    expect(await unanimousRows(action.id)).toHaveLength(0);
    expect(posts).toHaveLength(0);
  });
});
