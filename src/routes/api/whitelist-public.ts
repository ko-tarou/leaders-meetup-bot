import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import type { Env } from "../../types/env";
import { whitelistMembers, whitelistEntries } from "../../db/schema";
import { encryptToken, decryptToken } from "../../services/crypto";
import { checkConsensus } from "../../services/whitelist-consensus";

// 宗教イベント PR2: whitelist メンバー向け公開フォーム API (token-based)。
//
// 設計概要:
//   - 管理者が発行した magic-link token (whitelist_members.token) で本人を識別。
//   - メンバーは「会いたい/推薦したい人の名前リスト」を非公開で登録する。
//     リスト内容は AES-256-GCM (crypto.ts / WORKSPACE_TOKEN_KEY) で
//     whitelist_entries.name_encrypted に暗号化保存する (保存時暗号化)。
//   - 本人が再訪したとき自分の入力をそのまま見られるよう、正規化前の
//     生入力を暗号化して保存する (正規化は PR4 の全会一致集計でのみ使う)。
//   - 提出後に checkConsensus (PR4 で実装) を呼ぶ。
//
// 認証:
//   - 公開エンドポイント (/whitelist/:token) は src/routes/api.ts の adminAuth
//     除外パスに登録する (/participation/ と同じ扱い)。
//
// プライバシー:
//   - GET / POST いずれも token に一致した「その本人」の entries だけを
//     read / write する。他人の token では他人のリストを引けない。
export const whitelistPublicRouter = new Hono<{ Bindings: Env }>();

// 1 メンバーが登録できる名前の上限件数 / 1 件あたりの最大文字数。
const MAX_NAMES = 50;
const MAX_NAME_LENGTH = 100;

/** token から whitelist_members を引く。なければ null。 */
async function findMemberByToken(
  db: ReturnType<typeof drizzle>,
  token: string,
) {
  if (!token) return null;
  return (
    (await db
      .select()
      .from(whitelistMembers)
      .where(eq(whitelistMembers.token, token))
      .get()) ?? null
  );
}

// ---------------------------------------------------------------------------
// GET /whitelist/:token
//   本人の displayName と、復号した登録済み名前リストを返す。
//   token 不一致は 404 (他人のリストは引けない)。
// ---------------------------------------------------------------------------
whitelistPublicRouter.get("/whitelist/:token", async (c) => {
  const db = drizzle(c.env.DB);
  const token = c.req.param("token");

  const member = await findMemberByToken(db, token);
  if (!member) return c.json({ error: "invalid_token" }, 404);

  const entries = await db
    .select()
    .from(whitelistEntries)
    .where(eq(whitelistEntries.memberId, member.id))
    .all();
  entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const names = await Promise.all(
    entries.map((e) => decryptToken(e.nameEncrypted, c.env.WORKSPACE_TOKEN_KEY)),
  );

  return c.json({ displayName: member.displayName, names });
});

// ---------------------------------------------------------------------------
// POST /whitelist/:token
//   body { names: string[] }
//   各要素を trim し空文字を除去。件数 > 50 / 1 件 > 100 文字は 400。
//   既存 entries を全置換 (delete → insert) し、生入力を暗号化保存する。
//   保存後に submittedAt / updatedAt を更新し checkConsensus (PR4 スタブ) を呼ぶ。
// ---------------------------------------------------------------------------
whitelistPublicRouter.post("/whitelist/:token", async (c) => {
  const db = drizzle(c.env.DB);
  const token = c.req.param("token");

  const body = await c.req.json<{ names?: unknown }>();
  if (!Array.isArray(body.names)) {
    return c.json({ error: "names must be an array" }, 400);
  }
  // 各要素が文字列であることを確認しつつ trim → 空文字は除外。
  const cleaned: string[] = [];
  for (const n of body.names) {
    if (typeof n !== "string") {
      return c.json({ error: "each name must be a string" }, 400);
    }
    const trimmed = n.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length > MAX_NAME_LENGTH) {
      return c.json(
        { error: `name must be <= ${MAX_NAME_LENGTH} chars` },
        400,
      );
    }
    cleaned.push(trimmed);
  }
  if (cleaned.length > MAX_NAMES) {
    return c.json({ error: `too many names (max ${MAX_NAMES})` }, 400);
  }

  const member = await findMemberByToken(db, token);
  if (!member) return c.json({ error: "invalid_token" }, 404);

  const now = new Date().toISOString();

  // entries を全置換 (idempotent)。生入力を暗号化して保存する。
  await db
    .delete(whitelistEntries)
    .where(eq(whitelistEntries.memberId, member.id));
  for (const name of cleaned) {
    await db.insert(whitelistEntries).values({
      id: crypto.randomUUID(),
      memberId: member.id,
      nameEncrypted: await encryptToken(name, c.env.WORKSPACE_TOKEN_KEY),
      createdAt: now,
    });
  }

  await db
    .update(whitelistMembers)
    .set({ submittedAt: now, updatedAt: now })
    .where(eq(whitelistMembers.id, member.id));

  // 全会一致検出 + 通知 (PR4 で実装。現状は no-op スタブ)。
  await checkConsensus(db, member.eventActionId, c.env);

  return c.json({ ok: true, count: cleaned.length });
});
