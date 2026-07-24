/**
 * participant_broadcast: 参加者一斉送信の実行サービス (I/O を持つ層)。
 *
 * pure domain (`domain/broadcast/recipients.ts`) が parse / 差し込みを担い、
 * ここでは gmail 送信 (services/gmail-send) と送信ログ / 重複送信防止
 * (broadcast_sends テーブル) を扱う。
 *
 * 安全設計:
 *   - 実送信は send() のみ。preview() は Gmail に一切触れず件数と render 結果だけ返す。
 *   - 1 回の送信ごとに batchId (UUID) を発番し、(action, batch, email) UNIQUE で
 *     同一バッチ内の二重送信を物理的に防ぐ。
 *   - skipAlreadySent=true のとき、過去に status='sent' で送った宛先を除外する
 *     (誤って一斉送信を 2 回押しても同じ人に再送しない)。
 *   - 1 通ごとに try/catch し、失敗は failed としてログに残して次へ進む
 *     (1 通の失敗で全体を止めない)。
 */
import { drizzle } from "drizzle-orm/d1";
import { and, desc, eq } from "drizzle-orm";
import type { Env } from "../types/env";
import { broadcastSends, participationForms } from "../db/schema";
import { renderTemplate } from "../domain/email/template";
import { parseRecipients, type Recipient } from "../domain/broadcast/recipients";
import {
  buildKitRecipients,
  type SkippedParticipant,
} from "../domain/broadcast/kit";
import { sendGmailEmail, GmailSendError } from "./gmail-send";

/**
 * 参加者 (participation_forms) の学籍番号から KIT 在学生メールの宛先ソースを作る。
 *
 * 宛先ソースを「差し込める」形にするための participants ソース実装。
 * event 単位で status='submitted' の参加届を引き、学籍番号 -> KIT メールへ変換する。
 * 学籍番号が無い/不正な参加者は skipped に回す (実送信対象に含めない)。
 *
 * I/O (D1 参照) はここに閉じ、変換は pure domain (domain/broadcast/kit) に委譲する。
 */
export type ParticipantSource = {
  /** 既存 preview/send に渡す宛先テキスト (`表示名 <email>` 行)。 */
  recipientsText: string;
  /** 対象イベントの提出済み参加者総数。 */
  participantTotal: number;
  /** KIT メールを生成できた参加者数 (重複除去前)。 */
  withEmail: number;
  /** 学籍番号が無い/不正で除外した参加者。 */
  skipped: SkippedParticipant[];
};

export async function loadParticipantKitSource(
  env: Env,
  eventId: string,
): Promise<ParticipantSource> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      studentId: participationForms.studentId,
      name: participationForms.name,
    })
    .from(participationForms)
    .where(
      and(
        eq(participationForms.eventId, eventId),
        eq(participationForms.status, "submitted"),
      ),
    )
    .all();

  const built = buildKitRecipients(rows);
  return {
    recipientsText: built.recipientsText,
    participantTotal: rows.length,
    withEmail: built.emails.length,
    skipped: built.skipped,
  };
}

export type BroadcastPreview = {
  /** 送信対象 (invalid / duplicate 除外後) の宛先数。 */
  recipientCount: number;
  /** parse できなかった行。 */
  invalidLines: string[];
  /** 貼り付け内の重複により除外された件数。 */
  duplicateCount: number;
  /** skipAlreadySent により除外された「送信済み」件数。 */
  alreadySentCount: number;
  /** 先頭宛先で render した件名・本文サンプル (無ければ null)。 */
  sample: { to: string; subject: string; body: string } | null;
  /** 宛先メールの一覧 (確認用・先頭 200 件まで)。 */
  emails: string[];
};

function buildVars(r: Recipient): Record<string, string> {
  return { name: r.name, email: r.email };
}

/** 差し込み後の 1 通を組み立てる。 */
function renderFor(
  r: Recipient,
  subjectTpl: string,
  bodyTpl: string,
): { subject: string; body: string } {
  const vars = buildVars(r);
  return {
    subject: renderTemplate(subjectTpl, vars),
    body: renderTemplate(bodyTpl, vars),
  };
}

/** 過去に status='sent' で送信済みのメール集合を取得する。 */
async function loadAlreadySent(
  env: Env,
  eventActionId: string,
): Promise<Set<string>> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({ email: broadcastSends.recipientEmail })
    .from(broadcastSends)
    .where(
      and(
        eq(broadcastSends.eventActionId, eventActionId),
        eq(broadcastSends.status, "sent"),
      ),
    )
    .all();
  return new Set(rows.map((r) => r.email.toLowerCase()));
}

/**
 * ドライラン。Gmail に一切触れず、宛先件数と render サンプルだけ返す。
 */
export async function previewBroadcast(
  env: Env,
  args: {
    eventActionId: string;
    recipientsText: string;
    subject: string;
    body: string;
    skipAlreadySent: boolean;
  },
): Promise<BroadcastPreview> {
  const parsed = parseRecipients(args.recipientsText);
  let recipients = parsed.recipients;
  let alreadySentCount = 0;

  if (args.skipAlreadySent) {
    const sent = await loadAlreadySent(env, args.eventActionId);
    const before = recipients.length;
    recipients = recipients.filter((r) => !sent.has(r.email));
    alreadySentCount = before - recipients.length;
  }

  const sample =
    recipients.length > 0
      ? (() => {
          const r = recipients[0];
          const { subject, body } = renderFor(r, args.subject, args.body);
          return { to: r.email, subject, body };
        })()
      : null;

  return {
    recipientCount: recipients.length,
    invalidLines: parsed.invalidLines,
    duplicateCount: parsed.duplicateCount,
    alreadySentCount,
    sample,
    emails: recipients.slice(0, 200).map((r) => r.email),
  };
}

export type BroadcastSendResult = {
  batchId: string;
  attempted: number;
  sent: number;
  failed: number;
  /** 失敗した宛先と理由 (先頭のみ)。 */
  failures: { email: string; error: string }[];
};

/**
 * 実際の一斉送信。呼び出し側 (route) で confirm ゲートを通した後にのみ呼ぶ。
 *
 * gmailAccountId 未設定 / 宛先 0 件のときは何も送らず throw する。
 */
export async function sendBroadcast(
  env: Env,
  args: {
    eventActionId: string;
    gmailAccountId: string;
    recipientsText: string;
    subject: string;
    body: string;
    skipAlreadySent: boolean;
  },
): Promise<BroadcastSendResult> {
  if (!args.gmailAccountId) {
    throw new Error("gmailAccountId is required");
  }
  if (!args.subject.trim() || !args.body.trim()) {
    throw new Error("subject and body are required");
  }

  const parsed = parseRecipients(args.recipientsText);
  let recipients = parsed.recipients;
  if (args.skipAlreadySent) {
    const sent = await loadAlreadySent(env, args.eventActionId);
    recipients = recipients.filter((r) => !sent.has(r.email));
  }
  if (recipients.length === 0) {
    throw new Error("no recipients to send");
  }

  const db = drizzle(env.DB);
  const batchId = crypto.randomUUID();
  const result: BroadcastSendResult = {
    batchId,
    attempted: recipients.length,
    sent: 0,
    failed: 0,
    failures: [],
  };

  for (const r of recipients) {
    const { subject, body } = renderFor(r, args.subject, args.body);
    let status: "sent" | "failed" = "sent";
    let errorMessage: string | null = null;
    try {
      await sendGmailEmail(env, args.gmailAccountId, {
        to: r.email,
        subject,
        body,
      });
      result.sent++;
    } catch (e) {
      status = "failed";
      const msg =
        e instanceof GmailSendError
          ? `${e.message}${e.status ? ` (${e.status})` : ""}`
          : e instanceof Error
            ? e.message
            : String(e);
      errorMessage = msg.slice(0, 300);
      result.failed++;
      result.failures.push({ email: r.email, error: errorMessage });
    }

    await db
      .insert(broadcastSends)
      .values({
        id: crypto.randomUUID(),
        eventActionId: args.eventActionId,
        batchId,
        recipientEmail: r.email,
        recipientName: r.name,
        subject,
        status,
        errorMessage,
        createdAt: new Date().toISOString(),
      })
      // 同一バッチ内で同じ宛先を二度書かない (UNIQUE 制約の保険)。
      .onConflictDoNothing();
  }

  return result;
}

export type BroadcastLogRow = {
  id: string;
  batchId: string;
  recipientEmail: string;
  recipientName: string;
  subject: string;
  status: string;
  errorMessage: string | null;
  createdAt: string;
};

/** 送信ログを新しい順に返す (最大 limit 件)。 */
export async function listBroadcastLogs(
  env: Env,
  eventActionId: string,
  limit = 200,
): Promise<BroadcastLogRow[]> {
  const db = drizzle(env.DB);
  return db
    .select({
      id: broadcastSends.id,
      batchId: broadcastSends.batchId,
      recipientEmail: broadcastSends.recipientEmail,
      recipientName: broadcastSends.recipientName,
      subject: broadcastSends.subject,
      status: broadcastSends.status,
      errorMessage: broadcastSends.errorMessage,
      createdAt: broadcastSends.createdAt,
    })
    .from(broadcastSends)
    .where(eq(broadcastSends.eventActionId, eventActionId))
    .orderBy(desc(broadcastSends.createdAt))
    .limit(limit)
    .all();
}
