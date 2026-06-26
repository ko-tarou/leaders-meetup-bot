import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import type { Env } from "../../types/env";
import { events, applications, eventActions } from "../../db/schema";
import {
  sendParticipationNotification,
  sendParticipationUnresolvedNotification,
  type ParticipationFormLike,
} from "../../services/participation-notification";
import {
  readRoleAutoAssignConfig,
  resolveSlackUserId,
  resolveSlackUserIdByEmail,
  applyRoleAssignment,
  revokeRoleAssignment,
} from "../../services/role-auto-assign";
// Phase 1-C/1-D: D1 Repository seam。participation_forms の read/write を
// すべて Repository 経由に移行。デフォルト実装は現状 drizzle クエリと完全
// 等価（SQL・戻り値・順序・副作用順序・トランザクション境界不変）なので
// characterization は無改変で green。eventActions など他テーブルアクセス・
// 副作用（通知/ロール付与）の呼び出し位置は route の責務のまま据え置く。
import { getParticipationFormRepository } from "../../repositories/participation-form-repository";
// Phase 2-A: 提出ハンドラの純粋な判断/変換ロジックを domain へ抽出。
// バリデーション・devRoles 正規化・token→applicationId 判定・fields 組み立て
// は副作用ゼロの純関数。I/O（DB/Slack/通知/ロール付与）と時刻取得・
// トランザクション/fail-soft 境界・呼び出し順序は route のまま据え置く。
import {
  validateSubmission,
  normalizeDevRoles,
  resolveApplicationId,
  buildParticipationFields,
} from "../../domain/participation/submission";

// participation-form Phase1 PR2: 参加届フォームの公開 API + admin 一覧。
//
// 公開エンドポイント (/participation/*) は admin 認証を通さない。
// src/routes/api.ts の admin auth ミドルウェアは path prefix で bypass を
// 判定するため、そこに "/participation/" prefix を除外登録している
// (実際の bypass 判定は api.ts:56-82 / 除外登録は api.ts の sub.startsWith)。
export const participationRouter = new Hono<{ Bindings: Env }>();
// 提出ボディの検証ルール（VALID_GRADE/GENDER/ACTIVITY/DEV_ROLES）と
// その判定・正規化は Phase 2-A で domain/participation/submission.ts へ
// 移設（振る舞い不変）。route はここで純関数を呼ぶだけに薄くする。

// ---------------------------------------------------------------------------
// (a) 公開: token から prefill 用の応募情報を返す。
//     token 無し / 不一致 / 該当なしは {} を 200 で返す (graceful fallback)。
//     event 自体が存在しない eventId のみ 404。
// ---------------------------------------------------------------------------
participationRouter.get("/participation/:eventId/prefill", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");

  const event = await db
    .select()
    .from(events)
    .where(eq(events.id, eventId))
    .get();
  if (!event) return c.json({ error: "event not found" }, 404);

  const token = c.req.query("t");
  if (!token) return c.json({});

  // token は applications.participationToken 完全一致 + その応募の eventId が
  // path と一致する場合のみ返す (他 event の token で他人情報を引けないよう検証)。
  const app = await db
    .select()
    .from(applications)
    .where(eq(applications.participationToken, token))
    .get();
  if (!app || app.eventId !== eventId) return c.json({});

  return c.json({
    name: app.name,
    email: app.email,
    studentId: app.studentId ?? "",
  });
});

// ---------------------------------------------------------------------------
// (b) 公開: フォームヘッダ表示用に event 最小情報を返す。
//     /apply/:eventId/event と同等 (行数優先で簡潔に複製)。
// ---------------------------------------------------------------------------
participationRouter.get("/participation/:eventId/event", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");
  const event = await db
    .select()
    .from(events)
    .where(eq(events.id, eventId))
    .get();
  if (!event) return c.json({ error: "not_found" }, 404);
  return c.json({ id: event.id, name: event.name, type: event.type });
});

// ---------------------------------------------------------------------------
// (c) 公開: 参加届を提出する。
//     token 一致時は applicationId に紐づけて upsert (先 SELECT 分岐で
//     partial unique index に依存しない idempotent 実装)。token 不正でも
//     400 にせず直接提出 (applicationId=null) 扱い (仕様)。
// ---------------------------------------------------------------------------
participationRouter.post("/participation/:eventId", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");
  const body = await c.req.json<{
    token?: string;
    name?: string;
    // 参加届フリガナ欄: 全角カタカナ (FE 必須・BE 任意)。fields へ素通し。
    nameKana?: string;
    slackName?: string;
    // 名簿 Slack 連携強化 PR1: Slack 登録メアド (任意)。
    // あれば users.lookupByEmail で slack_user_id を解決する。
    slackEmail?: string;
    studentId?: string;
    department?: string;
    grade?: string;
    email?: string;
    gender?: string;
    hasAllergy?: boolean;
    allergyDetail?: string;
    otherAffiliations?: string;
    desiredActivity?: string;
    devRoles?: string[];
  }>();

  // 純粋なバリデーション判定は domain へ委譲（順序・条件・エラー文字列・
  // 短絡順すべて現状と同一）。400 応答の生成だけ route の責務に残す。
  const validation = validateSubmission(body);
  if (!validation.ok) {
    return c.json({ error: validation.error }, 400);
  }

  // event 存在確認
  const event = await db
    .select()
    .from(events)
    .where(eq(events.id, eventId))
    .get();
  if (!event) return c.json({ error: "event not found" }, 404);

  // token 解決: 一致 & eventId 一致のときのみ applicationId に紐づける。
  // 不正 token は 400 にせず直接提出扱い (applicationId=null)。
  // DB SELECT（副作用）は route に残し、紐付け判定だけ domain 純関数へ。
  let applicationId: string | null = null;
  if (body.token) {
    const app = await db
      .select()
      .from(applications)
      .where(eq(applications.participationToken, body.token))
      .get();
    applicationId = resolveApplicationId(app, eventId);
  }

  // devRoles 正規化と fields 組み立ては純関数へ委譲（trim/空→null/
  // boolean→0|1/JSON.stringify すべて現状の式と byte-identical）。
  // 時刻取得 new Date() は副作用なので route に残し now を渡す。
  const devRoles = normalizeDevRoles(body.devRoles);
  const now = new Date().toISOString();
  const fields = buildParticipationFields(body, eventId, devRoles, now);

  // 保存成功後の Slack 通知 (fail-soft)。member_application アクション config の
  // participationNotifications を参照。sendApplicationNotification と完全に対の
  // 実装で、通知失敗・member_application 不在は提出 API を失敗させない。
  // 応募作成側 (applications.ts:283) と同じく await + try/catch 方式に合わせる。
  const notifyParticipation = async () => {
    try {
      const action = await db
        .select()
        .from(eventActions)
        .where(
          and(
            eq(eventActions.eventId, eventId),
            eq(eventActions.actionType, "member_application"),
          ),
        )
        .get();
      if (!action) return; // member_application 不在 → 通知 no-op
      const formLike: ParticipationFormLike = {
        name: fields.name,
        email: fields.email,
        submittedAt: fields.submittedAt,
        nameKana: fields.nameKana,
        slackName: fields.slackName,
        studentId: fields.studentId,
        department: fields.department,
        grade: fields.grade,
        gender: fields.gender,
        desiredActivity: fields.desiredActivity,
        otherAffiliations: fields.otherAffiliations,
        devRoles,
      };
      await sendParticipationNotification(c.env, action.config, formLike);
    } catch (e) {
      console.error("[participation] notification hook error:", e);
    }
  };

  // 保存成功後のロール自動割当 (fail-soft)。member_application action の
  // config.roleAutoAssign を参照し、slackName を Slack ユーザーへ解決して
  // slack_user_id を保存、未却下なら付与ロールを assigned_role_ids へ保存する。
  // 解決/付与の失敗は提出 API (201) を失敗させない。3 保存経路すべてで
  // 確定した行 id を渡して呼ぶ。
  const autoAssignOnSubmit = async (rowId: string) => {
    try {
      const action = await db
        .select()
        .from(eventActions)
        .where(
          and(
            eq(eventActions.eventId, eventId),
            eq(eventActions.actionType, "member_application"),
          ),
        )
        .get();
      if (!action) return; // member_application 不在 → no-op
      const cfg = readRoleAutoAssignConfig(action.config);
      if (!cfg || !cfg.enabled) return; // 無効/未設定 → no-op

      // 名簿 Slack 連携強化 PR1: メアド優先で slack_user_id を解決する。
      // slack_email があれば users.lookupByEmail で 1 回引き、失敗時は
      // 既存の slack_name (表示名) ベース解決へ fallback する。
      // どちらも fail-soft (例外は内部で握り潰し null) のため、提出 API は
      // 解決失敗で 201 を返し続ける。slack_email 由来の解決失敗は本 hook
      // 内で console.error を 1 行残し、後続の運用調査の手掛かりにする。
      let slackUserId: string | null = null;
      if (fields.slackEmail) {
        try {
          slackUserId = await resolveSlackUserIdByEmail(
            c.env,
            cfg.workspaceId,
            fields.slackEmail,
          );
        } catch (e) {
          // resolveSlackUserIdByEmail 自体は throw しない設計だが、
          // provider 差し替え等の予期しない例外も握り潰す (fail-soft)。
          console.error("[participation] slack lookup failed:", e);
          slackUserId = null;
        }
        if (!slackUserId) {
          console.error(
            "[participation] slack lookup failed: email not resolved",
            fields.slackEmail,
          );
        }
      }
      if (!slackUserId && fields.slackName) {
        slackUserId = await resolveSlackUserId(
          c.env,
          cfg.workspaceId,
          fields.slackName,
        );
      }
      if (!slackUserId) {
        // 表示名解決に失敗 (未解決) → 運営へ通知。手動紐付け待ち。
        // この経路は roleAutoAssign 有効時のみ走る (上の cfg.enabled ガード)
        // ため、自動割当 OFF 時は「未解決」概念が無く発火しない。解決成功時は
        // この分岐に入らないので通知も飛ばない。fail-soft (通知失敗で提出を
        // ブロックしない)。formLike は fields から最小構成で組む。
        try {
          const unresolvedForm: ParticipationFormLike = {
            name: fields.name,
            email: fields.email,
            submittedAt: fields.submittedAt,
            nameKana: fields.nameKana,
            slackName: fields.slackName,
            studentId: fields.studentId,
            department: fields.department,
            grade: fields.grade,
            gender: fields.gender,
            desiredActivity: fields.desiredActivity,
            otherAffiliations: fields.otherAffiliations,
            devRoles,
          };
          await sendParticipationUnresolvedNotification(
            c.env,
            action.config,
            unresolvedForm,
          );
        } catch (e) {
          console.error("[participation] unresolved notify error:", e);
        }
        return; // 未解決 → 手動紐付け待ち (デフォルト維持)
      }

      await getParticipationFormRepository().updateById(db, rowId, {
        slackUserId,
      });

      const { assignedRoleIds } = await applyRoleAssignment(c.env, {
        memberApplicationActionConfig: action.config,
        form: {
          id: rowId,
          slackUserId,
          desiredActivity: fields.desiredActivity,
          devRoles: fields.devRoles,
          status: "submitted",
        },
      });
      if (assignedRoleIds.length > 0) {
        await getParticipationFormRepository().updateById(db, rowId, {
          assignedRoleIds: JSON.stringify(assignedRoleIds),
        });
      }
    } catch (e) {
      console.error("[participation] role auto-assign hook error:", e);
    }
  };

  // applicationId 非null: 既存行があれば UPDATE、無ければ INSERT (idempotent)。
  // partial unique index に依存せず先 SELECT で分岐 (roles.ts のメンバー
  // upsert と同思想 / 同時提出でも例外にならない)。
  if (applicationId !== null) {
    const existing = await getParticipationFormRepository().findByApplicationId(
      db,
      applicationId,
    );
    if (existing) {
      await getParticipationFormRepository().updateById(
        db,
        existing.id,
        fields,
      );
      await notifyParticipation();
      await autoAssignOnSubmit(existing.id);
      return c.json({ ok: true, id: existing.id }, 201);
    }
    const id = crypto.randomUUID();
    await getParticipationFormRepository().insert(db, {
      id,
      applicationId,
      createdAt: now,
      ...fields,
    });
    await notifyParticipation();
    await autoAssignOnSubmit(id);
    return c.json({ ok: true, id }, 201);
  }

  // 直接提出: 常に新規 INSERT。
  const id = crypto.randomUUID();
  await getParticipationFormRepository().insert(db, {
    id,
    applicationId: null,
    createdAt: now,
    ...fields,
  });
  await notifyParticipation();
  await autoAssignOnSubmit(id);
  return c.json({ ok: true, id }, 201);
});

// ---------------------------------------------------------------------------
// admin: イベント単位の参加届一覧 (submittedAt 降順)。x-admin-token 必須
// (/orgs/* は api.ts の bypass 対象外なので admin auth が適用される)。
// ---------------------------------------------------------------------------
participationRouter.get("/orgs/:eventId/participation-forms", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");

  const event = await db
    .select()
    .from(events)
    .where(eq(events.id, eventId))
    .get();
  if (!event) return c.json({ error: "event not found" }, 404);

  // Phase 1-C: 一覧 read を Repository 経由に移行（call site 1 点のみ）。
  // デフォルト実装は従来の drizzle クエリと同一 SQL・同一戻り値なので
  // 並び替え・整形は従来どおり route 側の責務のまま据え置く。
  const rows = await getParticipationFormRepository().listByEventId(
    db,
    eventId,
  );
  rows.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));

  return c.json(
    rows.map((r) => {
      let parsed: unknown = [];
      try {
        parsed = JSON.parse(r.devRoles);
      } catch {
        parsed = [];
      }
      let assigned: unknown = [];
      try {
        assigned = JSON.parse(r.assignedRoleIds);
      } catch {
        assigned = [];
      }
      // status / slackUserId は ...r で含まれる (migration 0046/0047)。
      // assignedRoleIds は devRoles 同様 JSON.parse して配列で返す。
      return {
        ...r,
        devRoles: Array.isArray(parsed) ? parsed : [],
        assignedRoleIds: Array.isArray(assigned) ? assigned : [],
      };
    }),
  );
});

// ---------------------------------------------------------------------------
// admin helper: form の存在 & eventId 所属を検証する
// (roles.ts の findRoleInAction と同等の堅さ。他 event の form を
//  操作させないため eventId 不一致は 400、存在しなければ 404)。
// ---------------------------------------------------------------------------
async function findParticipationForm(
  db: ReturnType<typeof drizzle>,
  eventId: string,
  id: string,
) {
  const form = await getParticipationFormRepository().findById(db, id);
  if (!form) return { error: "participation form not found", status: 404 as const };
  if (form.eventId !== eventId)
    return { error: "eventId mismatch", status: 400 as const };
  return { form };
}

// admin helper: 当該 event の member_application action.config を取得する
// (ロール自動割当 config 参照用。不在/取得失敗は null)。
async function getMemberApplicationConfig(
  db: ReturnType<typeof drizzle>,
  eventId: string,
): Promise<string | null> {
  const action = await db
    .select()
    .from(eventActions)
    .where(
      and(
        eq(eventActions.eventId, eventId),
        eq(eventActions.actionType, "member_application"),
      ),
    )
    .get();
  return action?.config ?? null;
}

const VALID_STATUS = ["submitted", "rejected"];

// ---------------------------------------------------------------------------
// admin: 参加届を削除する。x-admin-token 必須
// (/orgs/* は api.ts の bypass 対象外なので admin auth が適用される)。
// ---------------------------------------------------------------------------
participationRouter.delete(
  "/orgs/:eventId/participation-forms/:id",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const id = c.req.param("id");

    const found = await findParticipationForm(db, eventId, id);
    if ("error" in found) return c.json({ error: found.error }, found.status);

    await getParticipationFormRepository().deleteById(db, id);
    return c.json({ ok: true });
  },
);

// ---------------------------------------------------------------------------
// admin: 参加届の status を更新する (却下 / 却下解除を兼ねる)。
//   body { status: 'submitted' | 'rejected' }
//   status:'rejected' = 却下、status:'submitted' = 却下解除。
// x-admin-token 必須 (/orgs/* は admin auth 配下)。
// ---------------------------------------------------------------------------
participationRouter.patch(
  "/orgs/:eventId/participation-forms/:id",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const id = c.req.param("id");
    const body = await c.req.json<{ status?: string }>();

    if (
      typeof body.status !== "string" ||
      !VALID_STATUS.includes(body.status)
    ) {
      return c.json({ error: "invalid status" }, 400);
    }

    const found = await findParticipationForm(db, eventId, id);
    if ("error" in found) return c.json({ error: found.error }, found.status);

    // status DB 更新は従来どおり確実に行う (ロール操作はその後の付加処理)。
    await getParticipationFormRepository().updateById(db, id, {
      status: body.status,
    });

    // ロール剥奪 / 再付与 (fail-soft)。ロール操作失敗で status 更新を
    // 失敗させない。config 無効ならスキップ (status 更新自体は成功)。
    try {
      const config = await getMemberApplicationConfig(db, eventId);
      const cfg = readRoleAutoAssignConfig(config);
      const form = found.form;
      if (cfg && cfg.enabled && form.slackUserId) {
        if (body.status === "rejected") {
          // 却下: 保存済み assignedRoleIds を剥奪し実績を '[]' にクリア
          // (再付与時の二重記録防止)。
          let assigned: unknown = [];
          try {
            assigned = JSON.parse(form.assignedRoleIds);
          } catch {
            assigned = [];
          }
          const ids = Array.isArray(assigned)
            ? assigned.filter((x): x is string => typeof x === "string")
            : [];
          if (ids.length > 0) {
            await revokeRoleAssignment(c.env, {
              roleManagementActionId: cfg.roleManagementActionId,
              slackUserId: form.slackUserId,
              assignedRoleIds: ids,
            });
            await getParticipationFormRepository().updateById(db, id, {
              assignedRoleIds: "[]",
            });
          }
        } else if (body.status === "submitted") {
          // 却下解除 (復帰): 解決済みなら再付与する。
          const { assignedRoleIds } = await applyRoleAssignment(c.env, {
            memberApplicationActionConfig: config,
            form: {
              id,
              slackUserId: form.slackUserId,
              desiredActivity: form.desiredActivity,
              devRoles: form.devRoles,
              status: "submitted",
            },
          });
          if (assignedRoleIds.length > 0) {
            await getParticipationFormRepository().updateById(db, id, {
              assignedRoleIds: JSON.stringify(assignedRoleIds),
            });
          }
        }
      }
    } catch (e) {
      console.error("[participation] role status hook error:", e);
    }

    return c.json({ ok: true, status: body.status });
  },
);

// ---------------------------------------------------------------------------
// admin: 未解決フォームに Slack ユーザーを手動紐付けする。
//   body { slackUserId: string }
//   slack_user_id をセットし、却下でなく config 有効なら即付与して
//   assigned_role_ids を更新する (手動紐付け = 解決完了 → そのまま付与)。
// x-admin-token 必須 (/orgs/* は admin auth 配下)。
// ---------------------------------------------------------------------------
participationRouter.patch(
  "/orgs/:eventId/participation-forms/:id/slack-user",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const id = c.req.param("id");
    const body = await c.req.json<{ slackUserId?: string }>();

    if (
      typeof body.slackUserId !== "string" ||
      !body.slackUserId.trim()
    ) {
      return c.json({ error: "slackUserId is required" }, 400);
    }
    const slackUserId = body.slackUserId.trim();

    const found = await findParticipationForm(db, eventId, id);
    if ("error" in found) return c.json({ error: found.error }, found.status);

    await getParticipationFormRepository().updateById(db, id, { slackUserId });

    // 却下でなく config 有効なら即付与 (fail-soft: 付与失敗で 200 不変)。
    let assignedRoleIds: string[] = [];
    try {
      const form = found.form;
      if (form.status !== "rejected") {
        const config = await getMemberApplicationConfig(db, eventId);
        const cfg = readRoleAutoAssignConfig(config);
        if (cfg && cfg.enabled) {
          const res = await applyRoleAssignment(c.env, {
            memberApplicationActionConfig: config,
            form: {
              id,
              slackUserId,
              desiredActivity: form.desiredActivity,
              devRoles: form.devRoles,
              status: "submitted",
            },
          });
          assignedRoleIds = res.assignedRoleIds;
          if (assignedRoleIds.length > 0) {
            await getParticipationFormRepository().updateById(db, id, {
              assignedRoleIds: JSON.stringify(assignedRoleIds),
            });
          }
        }
      }
    } catch (e) {
      console.error("[participation] manual link role hook error:", e);
    }

    return c.json({ ok: true, slackUserId, assignedRoleIds });
  },
);

// ---------------------------------------------------------------------------
// admin: 既存参加届の運営ロール一括バックフィル。
//   当該 event の参加届のうち status != 'rejected' かつ slack_user_id 解決済み
//   の各行に applyRoleAssignment を適用する (冪等)。config.roleAutoAssign が
//   無効 / 未設定なら何もしない。alwaysAssignStaff 有効時は desiredActivity に
//   依らず運営ロールが付与される。既に運営に入っている人は applyRoleAssignment
//   内の「既存 (roleId, user) skip」で二重追加されない。
//   各行で確定した assignedRoleIds を participation_forms に保存し直す。
//   集計 (走査数 / 付与適用数 / 未解決スキップ数) を返す。
// x-admin-token 必須 (/orgs/* は admin auth 配下)。
// ---------------------------------------------------------------------------
participationRouter.post(
  "/orgs/:eventId/participation-forms/backfill-roles",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");

    const event = await db
      .select()
      .from(events)
      .where(eq(events.id, eventId))
      .get();
    if (!event) return c.json({ error: "event not found" }, 404);

    const config = await getMemberApplicationConfig(db, eventId);
    const cfg = readRoleAutoAssignConfig(config);
    if (!cfg || !cfg.enabled) {
      // config 無効 → 何もせず 0 件で返す (冪等・no-op)。
      return c.json({
        ok: true,
        enabled: false,
        scanned: 0,
        assigned: 0,
        skippedUnresolved: 0,
        skippedRejected: 0,
      });
    }

    const rows = await getParticipationFormRepository().listByEventId(
      db,
      eventId,
    );

    let scanned = 0;
    let assigned = 0;
    let skippedUnresolved = 0;
    let skippedRejected = 0;

    for (const form of rows) {
      scanned++;
      if (form.status === "rejected") {
        skippedRejected++;
        continue;
      }
      if (!form.slackUserId) {
        // 未解決 → 付与不能。手動紐付け待ち (backfill 対象外)。
        skippedUnresolved++;
        continue;
      }
      // fail-soft: 1 行の失敗で全体を止めない。
      try {
        const { assignedRoleIds } = await applyRoleAssignment(c.env, {
          memberApplicationActionConfig: config,
          form: {
            id: form.id,
            slackUserId: form.slackUserId,
            desiredActivity: form.desiredActivity,
            devRoles: form.devRoles,
            status: "submitted",
          },
        });
        if (assignedRoleIds.length > 0) {
          await getParticipationFormRepository().updateById(db, form.id, {
            assignedRoleIds: JSON.stringify(assignedRoleIds),
          });
          assigned++;
        }
      } catch (e) {
        console.error(
          `[participation] backfill role hook error for form ${form.id}:`,
          e,
        );
      }
    }

    console.log(
      `[participation] backfill-roles event=${eventId} scanned=${scanned} assigned=${assigned} skippedUnresolved=${skippedUnresolved} skippedRejected=${skippedRejected}`,
    );

    return c.json({
      ok: true,
      enabled: true,
      scanned,
      assigned,
      skippedUnresolved,
      skippedRejected,
    });
  },
);
