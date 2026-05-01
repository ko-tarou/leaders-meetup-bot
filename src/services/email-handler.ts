// Sprint 20 PR2: Cloudflare Email Routing 受信ハンドラ
// Worker.email() ハンドラから呼ばれ、ForwardableEmailMessage をパースして
// event_actions.config.addresses にマッチする event_id に incoming_emails レコードを insert する。
// 既存の webhook (POST /api/email-inbox/incoming) と並走するフォールバック構成。

import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import PostalMime from "postal-mime";
import { eventActions, incomingEmails } from "../db/schema";

type EmailHandlerEnv = {
  DB: D1Database;
};

// Cloudflare Email Routing が渡してくる ForwardableEmailMessage の最小定義。
// @cloudflare/workers-types で提供されているが、依存追加なしで動かすため
// 必要なフィールドだけを構造的に受ける。
type IncomingEmailMessage = {
  from: string;
  to: string;
  raw: ReadableStream<Uint8Array>;
  setReject?: (reason: string) => void;
};

/**
 * raw ReadableStream を Uint8Array にまとめる。
 * postal-mime は ArrayBuffer/Uint8Array/string を受けるため、まず全バイトを読み込む。
 */
async function readAllBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalSize = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      totalSize += value.length;
    }
  }
  const out = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Cloudflare Email Routing → Worker.email() 経由で受信した
 * ForwardableEmailMessage を処理する。
 *
 * - postal-mime で MIME パース
 * - to address を event_actions.config.addresses と突き合わせ
 * - 全マッチ event に incoming_emails を insert
 * - マッチが 0 件の場合は何もしない（DB保存しない）
 *
 * 失敗しても例外は呼び出し側へ伝搬させる（Email Routing 側は再配送しない設計のため、
 * ctx.waitUntil で握り潰す側でログ出力する）。
 */
export async function handleIncomingEmail(
  env: EmailHandlerEnv,
  message: IncomingEmailMessage,
): Promise<void> {
  const rawBytes = await readAllBytes(message.raw);

  const parser = new PostalMime();
  const parsed = await parser.parse(rawBytes);

  // Email Routing がヘッダから埋めてくれる to/from を一次情報とする。
  // 大量・大文字小文字混在の登録でも一致させたいので toLowerCase で正規化。
  const toAddr = (message.to || "").toLowerCase();
  const fromAddr = message.from || "";
  const fromName = parsed.from?.name ?? null;
  const subject = parsed.subject ?? null;
  const body = parsed.text ?? parsed.html ?? null;

  const db = drizzle(env.DB);
  const allActions = await db
    .select()
    .from(eventActions)
    .where(
      and(
        eq(eventActions.actionType, "email_inbox"),
        eq(eventActions.enabled, 1),
      ),
    )
    .all();

  const matchedEventIds: string[] = [];
  for (const a of allActions) {
    let cfg: { addresses?: { email?: string }[] } = {};
    try {
      cfg = JSON.parse(a.config || "{}");
    } catch {
      cfg = {};
    }
    const matches = (cfg.addresses || []).some(
      (addr) => addr.email && addr.email.toLowerCase() === toAddr,
    );
    if (matches) matchedEventIds.push(a.eventId);
  }

  if (matchedEventIds.length === 0) {
    // セキュリティ: 未登録アドレス宛のメールは保存せず、ログのみ。
    // Email Routing の catch-all を有効化していると任意のローカル部に送られうるので、
    // 登録済みアドレスにマッチしないものは捨てる。
    console.log(`[email] received for unregistered address: ${toAddr}`);
    return;
  }

  for (const eventId of matchedEventIds) {
    await db.insert(incomingEmails).values({
      id: crypto.randomUUID(),
      eventId,
      toAddress: toAddr,
      fromAddress: fromAddr,
      fromName,
      subject,
      body,
      receivedAt: new Date().toISOString(),
      rawData: JSON.stringify({
        messageId: parsed.messageId,
        date: parsed.date,
        cc: parsed.cc,
        replyTo: parsed.replyTo,
      }),
    });
  }

  console.log(
    `[email] inserted into ${matchedEventIds.length} event(s) for ${toAddr}`,
  );
}
