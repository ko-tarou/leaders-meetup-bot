import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq, and, gt } from "drizzle-orm";
import type { Env } from "../../types/env";
import { events, eventActions, sponsorApplications } from "../../db/schema";
import {
  sendSponsorNotification,
  sendSponsorConfirmEmail,
  sendSponsorEmailForTrigger,
} from "../../services/sponsor-application";

export const sponsorRouter = new Hono<{ Bindings: Env }>();

const ACTION_TYPE = "sponsor_application";

// 申込金額の上限ガード (誤入力 / いたずら対策)。1 億円。
const MAX_AMOUNT = 100_000_000;
// 簡易 rate-limit / 重複防止: 同一 (event, email) で直近この秒数以内の
// 申込があれば 429 を返す。メール確認 (confirmToken) と二段で spam を抑える。
const DUP_WINDOW_SEC = 60;

/** 不透明トークン生成 (32byte 乱数 → hex)。確認 URL / 推測防止に使う。 */
function generateConfirmToken(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** event 単位の sponsor_application action を取得 (1 event : 1 action 想定)。 */
async function findSponsorAction(
  db: ReturnType<typeof drizzle>,
  eventId: string,
) {
  return db
    .select()
    .from(eventActions)
    .where(
      and(
        eq(eventActions.eventId, eventId),
        eq(eventActions.actionType, ACTION_TYPE),
      ),
    )
    .get();
}

// ---------------------------------------------------------------------------
// 公開: フォーム表示用に event の最小情報を返す (認証不要)。
// PublicApplyPage と同じく id / name / type のみ返し、管理情報は漏らさない。
// ---------------------------------------------------------------------------
sponsorRouter.get("/sponsor/:eventId/event", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");
  const event = await db.select().from(events).where(eq(events.id, eventId)).get();
  if (!event) return c.json({ error: "not_found" }, 404);

  // 募集中か (action が存在し enabled) を伝える。FE はこれで受付停止表示を出す。
  const action = await findSponsorAction(db, eventId);
  return c.json({
    id: event.id,
    name: event.name,
    type: event.type,
    enabled: !!action && action.enabled === 1,
  });
});

// ---------------------------------------------------------------------------
// 公開: スポンサー申込受付 (認証不要)。
// 作成時は status='unconfirmed' とし、confirmToken 付き確認 URL を
// 申込者にメール送信する (メール確認方式のスパム対策)。
// Slack 通知は confirm 前から送る (運営が早く気付けるように。確認状態は表示する)。
// ---------------------------------------------------------------------------
sponsorRouter.post("/sponsor/:eventId", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");
  type SponsorBody = {
    companyName?: unknown;
    contactName?: unknown;
    email?: unknown;
    amount?: unknown;
    period?: unknown;
    purpose?: unknown;
  };
  const body = await c.req
    .json<SponsorBody>()
    .catch(() => ({}) as SponsorBody);

  // 必須バリデーション
  const companyName =
    typeof body.companyName === "string" ? body.companyName.trim() : "";
  const contactName =
    typeof body.contactName === "string" ? body.contactName.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!companyName) return c.json({ error: "companyName is required" }, 400);
  if (!contactName) return c.json({ error: "contactName is required" }, 400);
  if (!email) return c.json({ error: "email is required" }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: "invalid email format" }, 400);
  }
  // amount: 整数 (number or 数字文字列) で 1 以上 MAX_AMOUNT 以下。
  const amountNum =
    typeof body.amount === "number"
      ? body.amount
      : typeof body.amount === "string" && body.amount.trim() !== ""
        ? Number(body.amount)
        : NaN;
  if (!Number.isInteger(amountNum) || amountNum < 1 || amountNum > MAX_AMOUNT) {
    return c.json({ error: "invalid amount" }, 400);
  }
  const period =
    typeof body.period === "string" && body.period.trim()
      ? body.period.trim()
      : null;
  const purpose =
    typeof body.purpose === "string" && body.purpose.trim()
      ? body.purpose.trim()
      : null;

  // event 存在確認
  const event = await db.select().from(events).where(eq(events.id, eventId)).get();
  if (!event) return c.json({ error: "event not found" }, 404);

  // 簡易 rate-limit / 重複防止: 同一 (event, email) で直近 DUP_WINDOW_SEC 以内の
  // 申込があれば 429。短時間連投を弾く (メール確認方式と二段構え)。
  const cutoff = new Date(Date.now() - DUP_WINDOW_SEC * 1000).toISOString();
  const recent = await db
    .select({ id: sponsorApplications.id })
    .from(sponsorApplications)
    .where(
      and(
        eq(sponsorApplications.eventId, eventId),
        eq(sponsorApplications.email, email),
        gt(sponsorApplications.appliedAt, cutoff),
      ),
    )
    .get();
  if (recent) {
    return c.json({ error: "too_many_requests" }, 429);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const confirmToken = generateConfirmToken();
  await db.insert(sponsorApplications).values({
    id,
    eventId,
    companyName,
    contactName,
    email,
    amount: amountNum,
    period,
    purpose,
    status: "unconfirmed",
    decisionNote: null,
    confirmToken,
    confirmedAt: null,
    appliedAt: now,
    decidedAt: null,
  });

  // 通知 + 確認メール (fail-soft, action が無ければ no-op)。
  try {
    const action = await findSponsorAction(db, eventId);
    if (action) {
      // confirm エンドポイントは router が /api 配下にマウントされているため
      // /api を必ず含める (含めないと SPA fallback に吸われ confirm が動かない)。
      const confirmUrl = `${new URL(c.req.url).origin}/api/sponsor/${eventId}/confirm?t=${confirmToken}`;
      const appLike = {
        companyName,
        contactName,
        email,
        amount: amountNum,
        period,
        purpose,
        appliedAt: now,
        confirmUrl,
      };
      await sendSponsorNotification(c.env, action.config, appLike);
      await sendSponsorConfirmEmail(c.env, action.config, appLike);
    }
  } catch (e) {
    console.error("[sponsor] notification/email hook error:", e);
  }

  return c.json({ ok: true, id }, 201);
});

// ---------------------------------------------------------------------------
// 公開: メール確認 (認証不要)。確認 URL のトークンで unconfirmed → pending 昇格。
// ブラウザで踏まれる想定なので簡易 HTML を返す。
// ---------------------------------------------------------------------------
sponsorRouter.get("/sponsor/:eventId/confirm", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");
  const token = c.req.query("t") ?? "";
  if (!token) return c.html(confirmHtml("確認リンクが無効です。"), 400);

  const row = await db
    .select()
    .from(sponsorApplications)
    .where(
      and(
        eq(sponsorApplications.eventId, eventId),
        eq(sponsorApplications.confirmToken, token),
      ),
    )
    .get();
  if (!row) return c.html(confirmHtml("確認リンクが無効か、期限切れです。"), 404);

  // 既に確認済みなら冪等に成功扱い (同じトークンを2回踏んでもエラーにしない)。
  if (row.status === "unconfirmed") {
    await db
      .update(sponsorApplications)
      .set({ status: "pending", confirmedAt: new Date().toISOString() })
      .where(eq(sponsorApplications.id, row.id));
  }
  return c.html(
    confirmHtml(
      "メールアドレスの確認が完了しました。運営からの連絡をお待ちください。",
    ),
  );
});

// ---------------------------------------------------------------------------
// 管理: 申込一覧。デフォルトは確認済 (unconfirmed を除外) を新しい順で返す。
// ?status= で絞り込み、?includeUnconfirmed=1 で未確認も含める。
// ---------------------------------------------------------------------------
sponsorRouter.get("/orgs/:eventId/sponsor-applications", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");
  const status = c.req.query("status");
  const includeUnconfirmed = c.req.query("includeUnconfirmed") === "1";

  let rows = await db
    .select()
    .from(sponsorApplications)
    .where(eq(sponsorApplications.eventId, eventId))
    .all();
  if (status) {
    rows = rows.filter((r) => r.status === status);
  } else if (!includeUnconfirmed) {
    rows = rows.filter((r) => r.status !== "unconfirmed");
  }
  rows.sort((a, b) => b.appliedAt.localeCompare(a.appliedAt));
  return c.json(rows);
});

// 管理: 単一取得
sponsorRouter.get("/sponsor-applications/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const row = await db
    .select()
    .from(sponsorApplications)
    .where(eq(sponsorApplications.id, id))
    .get();
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(row);
});

// 管理: 更新 (status / decisionNote)。approve→お礼メール / reject→見送りメール。
sponsorRouter.put("/sponsor-applications/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  type UpdateBody = {
    status?: "pending" | "approved" | "rejected";
    decisionNote?: string | null;
  };
  const body = await c.req
    .json<UpdateBody>()
    .catch(() => ({}) as UpdateBody);

  const existing = await db
    .select()
    .from(sponsorApplications)
    .where(eq(sponsorApplications.id, id))
    .get();
  if (!existing) return c.json({ error: "Not found" }, 404);

  if (body.status && !["pending", "approved", "rejected"].includes(body.status)) {
    return c.json({ error: "invalid status" }, 400);
  }

  const updates: Partial<typeof existing> = {};
  if (body.status !== undefined) {
    updates.status = body.status;
    if (body.status === "approved" || body.status === "rejected") {
      updates.decidedAt = new Date().toISOString();
    }
  }
  if (body.decisionNote !== undefined) updates.decisionNote = body.decisionNote;

  if (Object.keys(updates).length === 0) return c.json(existing);

  const oldStatus = existing.status;
  await db
    .update(sponsorApplications)
    .set(updates)
    .where(eq(sponsorApplications.id, id));

  // status 遷移メール (fail-soft)。approved→onPassed / rejected→onFailed。
  if (body.status && body.status !== oldStatus) {
    try {
      const action = await findSponsorAction(db, existing.eventId);
      if (action && (body.status === "approved" || body.status === "rejected")) {
        await sendSponsorEmailForTrigger(
          c.env,
          action.config,
          {
            companyName: existing.companyName,
            contactName: existing.contactName,
            email: existing.email,
            amount: existing.amount,
            period: existing.period,
            purpose: existing.purpose,
            appliedAt: existing.appliedAt,
          },
          body.status === "approved" ? "onPassed" : "onFailed",
        );
      }
    } catch (e) {
      console.error("[sponsor] status transition hook error:", e);
    }
  }

  const updated = await db
    .select()
    .from(sponsorApplications)
    .where(eq(sponsorApplications.id, id))
    .get();
  return c.json(updated);
});

// 管理: 削除
sponsorRouter.delete("/sponsor-applications/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const existing = await db
    .select()
    .from(sponsorApplications)
    .where(eq(sponsorApplications.id, id))
    .get();
  if (!existing) return c.json({ error: "Not found" }, 404);
  await db.delete(sponsorApplications).where(eq(sponsorApplications.id, id));
  return c.json({ ok: true });
});

/** 確認ページの最小 HTML (依存を増やさないためインライン)。 */
function confirmHtml(message: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>スポンサー申込 確認</title></head><body style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 3rem auto; padding: 0 1rem; line-height: 1.6;"><h1 style="font-size: 1.25rem;">スポンサー申込</h1><p>${message}</p></body></html>`;
}
