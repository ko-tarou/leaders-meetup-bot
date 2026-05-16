import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq, and, ne } from "drizzle-orm";
import type { Env } from "../../types/env";
import { handleVote } from "../../services/poll";
import {
  handleAttendanceVote,
  type AttendanceChoice,
} from "../../services/attendance-check";
import {
  meetings,
  tasks,
  taskAssignees,
  prReviews,
  prReviewLgtms,
} from "../../db/schema";
import {
  buildStickyTaskAddModal,
  buildPRReviewAddModal,
  handleTaskAddSubmission,
} from "../../services/devhub-task-modal";
import { scheduleTaskReminders } from "../../services/devhub-task-reminder";
import { stickyRepostByChannel } from "../../services/sticky-task-board";
import {
  prReviewRepostByChannel,
  resolveLgtmThreshold,
  notifyReviewersAssigned,
} from "../../services/sticky-pr-review-board";
import { createSlackClientForWorkspace } from "../../services/workspace";
import { reRequestReview } from "../../services/pr-review-actions";
import { getSlackClient, type SlackVariables } from "./utils";
import { gmailAccounts } from "../../db/schema";
import {
  parseWatcherConfig,
  type WatcherRule,
} from "../../services/gmail-watcher";
import {
  fetchOriginalMessage,
  parseFromHeader,
  sendGmailReply,
} from "../../services/gmail-reply";
import { renderTemplate } from "../../services/application-notification";
import { utcToJstFormat } from "../../services/time-utils";

export const interactionsRouter = new Hono<{
  Bindings: Env;
  Variables: SlackVariables;
}>();

interactionsRouter.post("/interactions", async (c) => {
  const rawBody = c.get("rawBody");
  const params = new URLSearchParams(rawBody);
  const payloadStr = params.get("payload");
  if (!payloadStr) return c.json({ ok: true });

  const payload = JSON.parse(payloadStr);

  if (payload.type === "block_actions") {
    const action = payload.actions?.[0];
    if (!action) return c.json({ ok: true });

    if (action.action_id?.startsWith("poll_vote_")) {
      const optionId = action.value;
      const userId = payload.user?.id;
      if (!optionId || !userId) return c.json({ ok: true });

      const client = getSlackClient(c);
      try {
        await handleVote(c.env.DB, client, optionId, userId);
      } catch (error) {
        console.error("Failed to handle vote:", error);
      }
    }

    // Sprint 23 PR2: 出席確認 (attendance_check) の投票ボタン。
    // action_id 形式: `attendance_vote_${pollId}_${choice}`
    // pollId は UUID (英数字 + ハイフン)、choice は "attend" | "absent" | "undecided"。
    // 末尾の choice を rsplit("_") 1 回で分離する。
    if (action.action_id?.startsWith("attendance_vote_")) {
      const userId = payload.user?.id;
      const responseUrl: string | null = payload.response_url ?? null;
      if (!userId) return c.json({ ok: true });

      const rest = action.action_id.slice("attendance_vote_".length);
      const lastUnderscore = rest.lastIndexOf("_");
      if (lastUnderscore <= 0) return c.json({ ok: true });
      const pollId = rest.slice(0, lastUnderscore);
      const choiceRaw = rest.slice(lastUnderscore + 1);
      const validChoices: AttendanceChoice[] = [
        "attend",
        "absent",
        "undecided",
      ];
      if (!validChoices.includes(choiceRaw as AttendanceChoice)) {
        return c.json({ ok: true });
      }
      const choice = choiceRaw as AttendanceChoice;

      // 3 秒以内に ack。実処理は waitUntil。
      c.executionCtx.waitUntil(
        (async () => {
          const client = getSlackClient(c);
          try {
            await handleAttendanceVote(c.env.DB, client, {
              pollId,
              slackUserId: userId,
              choice,
              responseUrl,
            });
          } catch (e) {
            console.error("Failed to handle attendance vote:", e);
          }
        })(),
      );

      return c.json({ ok: true });
    }

    // /devhub task list の「完了」ボタン: タスクを done に更新（ADR-0002）
    if (action.action_id?.startsWith("devhub_task_done_")) {
      const taskId = action.value;
      const actorId = payload.user?.id;
      if (!taskId) return c.json({ ok: true });

      // 3秒制限内に応答するため waitUntil でバックグラウンド処理
      c.executionCtx.waitUntil(
        (async () => {
          const d1 = drizzle(c.env.DB);
          const client = getSlackClient(c);
          try {
            const now = new Date().toISOString();
            await d1
              .update(tasks)
              .set({ status: "done", updatedAt: now })
              .where(eq(tasks.id, taskId));

            // タスクの reminder ジョブも pending のまま残る意味が無いので削除（任意・冪等）
            await scheduleTaskReminders(c.env.DB, taskId, null, "", []);

            if (actorId) {
              await client.postMessage(actorId, "✅ タスクを完了にしました");
            }
          } catch (e) {
            console.error("Failed to mark devhub task done:", e);
            if (actorId) {
              try {
                await client.postMessage(
                  actorId,
                  "⚠️ タスクの完了処理に失敗しました。時間をおいて再度お試しください。",
                );
              } catch (notifyErr) {
                console.error("Failed to notify task done failure:", notifyErr);
              }
            }
          }
        })(),
      );

      return c.json({ ok: true });
    }

    // === ADR-0006 sticky board: 担当者トグル ===
    // sticky_assign_<taskId>: 押した本人を担当者として toggle
    //   - 既にアサインされていれば解除、なければ追加
    //   - tasks.updatedAt を必ず更新（並び替えのため）
    //   - その後 sticky board を即時 repost（10秒デバウンスは message event 専用）
    if (action.action_id?.startsWith("sticky_assign_")) {
      const taskId = action.value;
      const userId = payload.user?.id;
      const channelId = payload.channel?.id;
      if (!taskId || !userId || !channelId) return c.json({ ok: true });

      c.executionCtx.waitUntil(
        (async () => {
          try {
            const d1 = drizzle(c.env.DB);
            const existing = await d1
              .select()
              .from(taskAssignees)
              .where(
                and(
                  eq(taskAssignees.taskId, taskId),
                  eq(taskAssignees.slackUserId, userId),
                ),
              )
              .get();

            const now = new Date().toISOString();
            if (existing) {
              await d1
                .delete(taskAssignees)
                .where(
                  and(
                    eq(taskAssignees.taskId, taskId),
                    eq(taskAssignees.slackUserId, userId),
                  ),
                );
            } else {
              await d1.insert(taskAssignees).values({
                id: crypto.randomUUID(),
                taskId,
                slackUserId: userId,
                assignedAt: now,
              });
            }
            await d1
              .update(tasks)
              .set({ updatedAt: now })
              .where(eq(tasks.id, taskId));

            await stickyRepostByChannel(c.env, channelId);
          } catch (e) {
            console.error("Failed to handle sticky_assign:", e);
          }
        })(),
      );

      return c.json({ ok: true });
    }

    // === ADR-0006 sticky board: 完了 ===
    // sticky_done_<taskId>: タスクを done に更新 → 即時 repost
    if (action.action_id?.startsWith("sticky_done_")) {
      const taskId = action.value;
      const channelId = payload.channel?.id;
      if (!taskId || !channelId) return c.json({ ok: true });

      c.executionCtx.waitUntil(
        (async () => {
          try {
            const d1 = drizzle(c.env.DB);
            const now = new Date().toISOString();
            await d1
              .update(tasks)
              .set({ status: "done", updatedAt: now })
              .where(eq(tasks.id, taskId));

            // pending 中のリマインドジョブも掃除（冪等、devhub_task_done_ と同じ扱い）
            try {
              await scheduleTaskReminders(c.env.DB, taskId, null, "", []);
            } catch (remErr) {
              console.error("Failed to clear sticky task reminders:", remErr);
            }

            await stickyRepostByChannel(c.env, channelId);
          } catch (e) {
            console.error("Failed to handle sticky_done:", e);
          }
        })(),
      );

      return c.json({ ok: true });
    }

    // === ADR-0006 sticky board: 新規タスク作成モーダルを開く ===
    // value に meetingId が入っている。trigger_id は 3 秒で失効するため waitUntil
    // 内でも極力早く openView を叩く。
    if (action.action_id === "sticky_create") {
      const meetingId = action.value;
      const triggerId = payload.trigger_id;
      if (!meetingId || !triggerId) return c.json({ ok: true });

      c.executionCtx.waitUntil(
        (async () => {
          try {
            const d1 = drizzle(c.env.DB);
            const meeting = await d1
              .select()
              .from(meetings)
              .where(eq(meetings.id, meetingId))
              .get();
            if (
              !meeting ||
              !meeting.eventId ||
              !meeting.workspaceId ||
              !meeting.channelId
            ) {
              console.warn(
                `sticky_create: meeting ${meetingId} not ready (eventId/workspaceId/channelId missing)`,
              );
              return;
            }

            const client = await createSlackClientForWorkspace(
              c.env,
              meeting.workspaceId,
            );
            if (!client) {
              console.warn(
                `sticky_create: no SlackClient for workspace ${meeting.workspaceId}`,
              );
              return;
            }

            const userId = payload.user?.id || "";
            const view = buildStickyTaskAddModal({
              eventId: meeting.eventId,
              channelId: meeting.channelId,
              createdBySlackId: userId,
            });
            const res = await client.openView(triggerId, view);
            if (!res.ok) {
              console.error("sticky_create views.open returned not ok:", res);
            }
          } catch (e) {
            console.error("Failed to open sticky_create modal:", e);
          }
        })(),
      );

      return c.json({ ok: true });
    }

    // === Sprint 14 PR1: 未開始タスクの表示切替 ===
    // sticky_show_unstarted_<meetingId>: meetings.task_board_show_unstarted を 1 にして repost
    if (action.action_id?.startsWith("sticky_show_unstarted_")) {
      const meetingId = action.value;
      const channelId = payload.channel?.id;
      if (!meetingId || !channelId) return c.json({ ok: true });

      c.executionCtx.waitUntil(
        (async () => {
          try {
            const d1 = drizzle(c.env.DB);
            await d1
              .update(meetings)
              .set({ taskBoardShowUnstarted: 1 })
              .where(eq(meetings.id, meetingId));
            await stickyRepostByChannel(c.env, channelId);
          } catch (e) {
            console.error("Failed to handle sticky_show_unstarted:", e);
          }
        })(),
      );

      return c.json({ ok: true });
    }

    // sticky_hide_unstarted_<meetingId>: 0 に戻して repost
    if (action.action_id?.startsWith("sticky_hide_unstarted_")) {
      const meetingId = action.value;
      const channelId = payload.channel?.id;
      if (!meetingId || !channelId) return c.json({ ok: true });

      c.executionCtx.waitUntil(
        (async () => {
          try {
            const d1 = drizzle(c.env.DB);
            await d1
              .update(meetings)
              .set({ taskBoardShowUnstarted: 0 })
              .where(eq(meetings.id, meetingId));
            await stickyRepostByChannel(c.env, channelId);
          } catch (e) {
            console.error("Failed to handle sticky_hide_unstarted:", e);
          }
        })(),
      );

      return c.json({ ok: true });
    }

    // === ADR-0008 PR レビュー sticky board actions ===
    // 注: sticky_pr_take_ ハンドラは LGTM ベース運用への移行に伴い削除済み
    // （複数人で LGTM するモデルに単一担当者の概念は不要）。
    // DB の reviewerSlackId 列・in_review ステータスは Web UI 編集用に温存。

    // sticky_pr_lgtm_<reviewId>: LGTM をトグル（同じユーザーが再押下で取消）。
    // 2 つ集まったら自動で status='merged' に遷移し、依頼者にメンションで完了通知を post。
    if (action.action_id?.startsWith("sticky_pr_lgtm_")) {
      const reviewId = action.value;
      const userId = payload.user?.id;
      const channelId = payload.channel?.id;
      if (!reviewId || !userId || !channelId) return c.json({ ok: true });

      c.executionCtx.waitUntil(
        (async () => {
          try {
            const d1 = drizzle(c.env.DB);

            // 既に LGTM 済みかチェック
            const existing = await d1
              .select()
              .from(prReviewLgtms)
              .where(
                and(
                  eq(prReviewLgtms.reviewId, reviewId),
                  eq(prReviewLgtms.slackUserId, userId),
                ),
              )
              .get();

            if (existing) {
              // すでに LGTM 済み → トグルとして削除
              await d1
                .delete(prReviewLgtms)
                .where(
                  and(
                    eq(prReviewLgtms.reviewId, reviewId),
                    eq(prReviewLgtms.slackUserId, userId),
                  ),
                );
            } else {
              // 新規 LGTM
              await d1.insert(prReviewLgtms).values({
                id: crypto.randomUUID(),
                reviewId,
                slackUserId: userId,
                createdAt: new Date().toISOString(),
              });

              // LGTM 数を確認。しきい値は当該 review が属する event の
              // pr_review_list config から解決（未設定 / 不正は 2 に fallback）
              const lgtms = await d1
                .select()
                .from(prReviewLgtms)
                .where(eq(prReviewLgtms.reviewId, reviewId))
                .all();
              const reviewRow = await d1
                .select({ eventId: prReviews.eventId })
                .from(prReviews)
                .where(eq(prReviews.id, reviewId))
                .get();
              const lgtmThreshold = reviewRow
                ? await resolveLgtmThreshold(c.env.DB, reviewRow.eventId)
                : 2;

              if (lgtms.length >= lgtmThreshold) {
                // status='merged' への遷移を atomic 化して二重通知を防ぐ
                // (multi-review #27 R5 [must])。
                // WHERE status != 'merged' + RETURNING で「自分が初めて
                // merged にした worker」だけが notification を post する。
                // 同時に LGTM が閾値を超えた他の worker は returning が空配列
                // となり、通知 post をスキップする。
                const transitioned = await d1
                  .update(prReviews)
                  .set({
                    status: "merged",
                    updatedAt: new Date().toISOString(),
                  })
                  .where(
                    and(
                      eq(prReviews.id, reviewId),
                      ne(prReviews.status, "merged"),
                    ),
                  )
                  .returning({
                    id: prReviews.id,
                    title: prReviews.title,
                    requesterSlackId: prReviews.requesterSlackId,
                  });

                if (transitioned.length > 0) {
                  const review = transitioned[0];
                  // チャンネルに通知 post（依頼者にメンション）
                  const meeting = await d1
                    .select()
                    .from(meetings)
                    .where(eq(meetings.channelId, channelId))
                    .get();
                  if (meeting && meeting.workspaceId) {
                    const client = await createSlackClientForWorkspace(
                      c.env,
                      meeting.workspaceId,
                    );
                    if (client) {
                      const message = `<@${review.requesterSlackId}> 「${review.title}」のレビューが完了しました 🎉`;
                      try {
                        await client.postMessage(channelId, message);
                      } catch (e) {
                        console.error(
                          "Failed to post completion message:",
                          e,
                        );
                      }
                    }
                  }
                }
              }
            }

            // ボード repost
            await prReviewRepostByChannel(c.env, channelId);
          } catch (e) {
            console.error("Failed to handle sticky_pr_lgtm:", e);
          }
        })(),
      );

      return c.json({ ok: true });
    }

    // sticky_pr_done_<reviewId>: status=merged に更新 → 即時 repost（ボードから消える）
    if (action.action_id?.startsWith("sticky_pr_done_")) {
      const reviewId = action.value;
      const channelId = payload.channel?.id;
      if (!reviewId || !channelId) return c.json({ ok: true });

      c.executionCtx.waitUntil(
        (async () => {
          try {
            const d1 = drizzle(c.env.DB);
            await d1
              .update(prReviews)
              .set({
                status: "merged",
                updatedAt: new Date().toISOString(),
              })
              .where(eq(prReviews.id, reviewId));
            await prReviewRepostByChannel(c.env, channelId);
          } catch (e) {
            console.error("Failed to handle sticky_pr_done:", e);
          }
        })(),
      );

      return c.json({ ok: true });
    }

    // sticky_pr_rereview_<reviewId>: 完了済み PR の「🔄 再レビュー依頼」ボタン。
    // LGTM 全削除 + status='open' + review_round++ + reviewer 再通知 + board repost。
    // ロジックは services/pr-review-actions.ts の reRequestReview に共通化済み
    // （Web API `POST .../re-request` と同一処理）。board repost は
    // reRequestReview 内で実施されるため、ここでは二重 repost しない。
    // fail-soft: 失敗してもログのみ（既存 sticky_pr_* ハンドラと同じ作法）。
    if (action.action_id?.startsWith("sticky_pr_rereview_")) {
      const reviewId = action.value;
      if (!reviewId) return c.json({ ok: true });

      c.executionCtx.waitUntil(
        (async () => {
          try {
            const d1 = drizzle(c.env.DB);
            const reviewRow = await d1
              .select({ eventId: prReviews.eventId })
              .from(prReviews)
              .where(eq(prReviews.id, reviewId))
              .get();
            if (!reviewRow) {
              console.warn(
                `sticky_pr_rereview: review ${reviewId} not found`,
              );
              return;
            }
            await reRequestReview(c.env, {
              eventId: reviewRow.eventId,
              reviewId,
            });
          } catch (e) {
            console.error("Failed to handle sticky_pr_rereview:", e);
          }
        })(),
      );

      return c.json({ ok: true });
    }

    // sticky_pr_review_<reviewId>: 予備の手動「レビュー中」遷移（将来用）
    // 現状は使わないが action_id プレフィックスは仕様書で予約済み。
    if (action.action_id?.startsWith("sticky_pr_review_")) {
      const reviewId = action.value;
      const userId = payload.user?.id;
      const channelId = payload.channel?.id;
      if (!reviewId || !userId || !channelId) return c.json({ ok: true });

      c.executionCtx.waitUntil(
        (async () => {
          try {
            const d1 = drizzle(c.env.DB);
            await d1
              .update(prReviews)
              .set({
                reviewerSlackId: userId,
                status: "in_review",
                updatedAt: new Date().toISOString(),
              })
              .where(eq(prReviews.id, reviewId));
            await prReviewRepostByChannel(c.env, channelId);
          } catch (e) {
            console.error("Failed to handle sticky_pr_review:", e);
          }
        })(),
      );

      return c.json({ ok: true });
    }

    // sticky_pr_create: 「+ 新規レビュー依頼」ボタン → モーダル open
    // value に meetingId が入っている。trigger_id は 3 秒で失効するため waitUntil
    // 内でも極力早く openView を叩く。
    if (action.action_id === "sticky_pr_create") {
      const meetingId = action.value;
      const triggerId = payload.trigger_id;
      if (!meetingId || !triggerId) return c.json({ ok: true });

      c.executionCtx.waitUntil(
        (async () => {
          try {
            const d1 = drizzle(c.env.DB);
            const meeting = await d1
              .select()
              .from(meetings)
              .where(eq(meetings.id, meetingId))
              .get();
            if (
              !meeting ||
              !meeting.eventId ||
              !meeting.workspaceId ||
              !meeting.channelId
            ) {
              console.warn(
                `sticky_pr_create: meeting ${meetingId} not ready (eventId/workspaceId/channelId missing)`,
              );
              return;
            }

            const client = await createSlackClientForWorkspace(
              c.env,
              meeting.workspaceId,
            );
            if (!client) {
              console.warn(
                `sticky_pr_create: no SlackClient for workspace ${meeting.workspaceId}`,
              );
              return;
            }

            const userId = payload.user?.id || "";
            const view = buildPRReviewAddModal(
              meeting.eventId,
              userId,
              meeting.channelId,
            );
            const res = await client.openView(triggerId, view);
            if (!res.ok) {
              console.error("sticky_pr_create views.open returned not ok:", res);
            }
          } catch (e) {
            console.error("Failed to open sticky_pr_create modal:", e);
          }
        })(),
      );

      return c.json({ ok: true });
    }

    // === Sprint 27: Gmail watcher 自動返信ボタン ===
    // gmail_watcher_reply: Gmail API で original message に返信し、
    //   Slack メッセージを「✅ 返信送信済」表示に更新する (ボタン削除)。
    // gmail_watcher_skip:  Slack メッセージを「❌ スキップ済」表示に更新する。
    //
    // 通知時点で rule.autoReply.enabled=true だった rule のみ呼ばれる。
    // value JSON:
    //   reply: {gmailAccountId, messageId, ruleId, workspaceId, channelId}
    //   skip:  {messageId}
    if (
      action.action_id === "gmail_watcher_reply" ||
      action.action_id === "gmail_watcher_skip"
    ) {
      const responseUrl: string | null = payload.response_url ?? null;
      const userId: string | undefined = payload.user?.id;
      const valueStr: string | undefined = action.value;
      const isReply = action.action_id === "gmail_watcher_reply";

      // skip は即時 update して終了。
      if (!isReply) {
        c.executionCtx.waitUntil(
          updateOriginalMessage(responseUrl, `❌ <@${userId ?? ""}> がスキップしました`),
        );
        return c.json({ ok: true });
      }

      if (!valueStr || !userId) return c.json({ ok: true });
      let payloadValue: GmailReplyButtonValue | null = null;
      try {
        payloadValue = JSON.parse(valueStr) as GmailReplyButtonValue;
      } catch {
        payloadValue = null;
      }
      if (
        !payloadValue ||
        !payloadValue.gmailAccountId ||
        !payloadValue.messageId ||
        !payloadValue.ruleId
      ) {
        return c.json({ ok: true });
      }

      c.executionCtx.waitUntil(
        handleGmailWatcherReply(c.env, payloadValue, userId, responseUrl),
      );

      return c.json({ ok: true });
    }
  }

  if (payload.type === "view_submission") {
    const view = payload.view;
    if (view?.callback_id === "devhub_task_add_submit") {
      // 共通ハンドラに委譲（multi-review #32 R2 [must]）
      return handleTaskAddSubmission(c, payload, {
        variant: "devhub",
        missingEventErrorText:
          "イベント情報が失われています。コマンドを再実行してください。",
      });
    }

    // === ADR-0006 sticky board: タスク作成モーダルのサブミット ===
    // devhub_task_add_submit と同じ処理に加え、最後に sticky board を
    // 即時 repost する。共通ロジックは handleTaskAddSubmission に集約済み。
    if (view?.callback_id === "sticky_task_add_submit") {
      return handleTaskAddSubmission(c, payload, {
        variant: "sticky",
        missingEventErrorText:
          "イベント情報が失われています。ボードの新規ボタンを押し直してください。",
      });
    }

    // === ADR-0008 PR レビュー sticky board: 新規レビュー依頼モーダルのサブミット ===
    if (view?.callback_id === "sticky_pr_review_add_submit") {
      let meta: {
        eventId?: string;
        requesterSlackId?: string;
        channelId?: string;
      } = {};
      try {
        meta = JSON.parse(view.private_metadata || "{}");
      } catch {
        meta = {};
      }
      const eventId = meta.eventId;
      const channelId = meta.channelId || "";
      const requesterSlackId =
        meta.requesterSlackId || payload.user?.id || "";

      const values = view.state?.values || {};
      const title: string | undefined =
        values.title_block?.title_input?.value;
      const url: string | null =
        values.url_block?.url_input?.value || null;
      const description: string | null =
        values.desc_block?.desc_input?.value || null;
      const reviewerSlackId: string | null =
        values.reviewer_block?.reviewer_input?.selected_user || null;

      if (!title || !title.trim()) {
        return c.json({
          response_action: "errors",
          errors: { title_block: "タイトルは必須です" },
        });
      }
      if (!eventId) {
        return c.json({
          response_action: "errors",
          errors: {
            title_block:
              "イベント情報が失われています。ボードの新規ボタンを押し直してください。",
          },
        });
      }

      c.executionCtx.waitUntil(
        (async () => {
          const d1 = drizzle(c.env.DB);
          try {
            const reviewId = crypto.randomUUID();
            const now = new Date().toISOString();
            // レビュアー指定があれば即 in_review、無ければ open
            const initialStatus = reviewerSlackId ? "in_review" : "open";
            await d1.insert(prReviews).values({
              id: reviewId,
              eventId,
              title,
              url,
              description,
              status: initialStatus,
              requesterSlackId,
              reviewerSlackId,
              createdAt: now,
              updatedAt: now,
            });

            if (channelId) {
              try {
                await prReviewRepostByChannel(c.env, channelId);
              } catch (repErr) {
                console.error(
                  "Failed to repost pr review sticky after create:",
                  repErr,
                );
              }
              // 割当レビュアーへ「依頼が来た」明示メンション通知
              // （reviewer 未指定なら notifyReviewersAssigned 側で no-op）。
              // fail-soft: 関数内 try/catch で握りつぶすため作成は失敗しない。
              await notifyReviewersAssigned(c.env, {
                channelId,
                reviewerSlackIds: reviewerSlackId ? [reviewerSlackId] : [],
                title,
                url,
                requesterSlackId,
              });
            }
          } catch (e) {
            console.error(
              "Failed to create pr review from sticky modal:",
              e,
            );
          }
        })(),
      );

      return c.json({});
    }
  }

  return c.json({ ok: true });
});

// =============================================================================
// Sprint 27: Gmail watcher 自動返信ハンドラ
// =============================================================================

type GmailReplyButtonValue = {
  gmailAccountId: string;
  messageId: string;
  ruleId: string;
  workspaceId?: string;
  channelId?: string;
};

/**
 * 「自動返信を送る」ボタン押下時の本体処理。waitUntil 配下で呼ばれる。
 *
 * フロー:
 *   1. gmail_accounts.watcher_config を読み、ruleId に対応する rule を探す
 *   2. rule.autoReply が無い / enabled=false なら 「無効化済み」と表示
 *   3. Gmail API で original message を取得 (From / Subject / Message-ID / threadId)
 *   4. Reply 構築 + Gmail send (threadId 指定で同一スレッド)
 *   5. Slack メッセージを「✅ 返信送信済」表示に update (ボタン削除)
 *
 * fail-soft: 各段階で失敗したら Slack メッセージにエラー文を反映し、log を出す。
 * Gmail 送信失敗で notification 自体は壊さない (= 既に届いた通知メッセージは
 * 「❌ 送信失敗」表示に書き換わるだけで Slack 全体は止めない)。
 */
async function handleGmailWatcherReply(
  env: Env,
  v: GmailReplyButtonValue,
  actorUserId: string,
  responseUrl: string | null,
): Promise<void> {
  try {
    // 1) rule を find
    const d1 = drizzle(env.DB);
    const account = await d1
      .select()
      .from(gmailAccounts)
      .where(eq(gmailAccounts.id, v.gmailAccountId))
      .get();
    if (!account) {
      await updateOriginalMessage(
        responseUrl,
        "⚠️ Gmail アカウントが見つかりませんでした",
      );
      return;
    }
    const cfg = parseWatcherConfig(account.watcherConfig);
    const rule = findRuleById(cfg, v.ruleId);
    if (!rule) {
      await updateOriginalMessage(
        responseUrl,
        "⚠️ ルールが見つかりませんでした (設定が変更された可能性があります)",
      );
      return;
    }
    if (!rule.autoReply || !rule.autoReply.enabled) {
      await updateOriginalMessage(
        responseUrl,
        "⚠️ 自動返信が無効化されています",
      );
      return;
    }

    // 2) original message 取得
    const original = await fetchOriginalMessage(
      env,
      v.gmailAccountId,
      v.messageId,
    );
    if (!original.threadId) {
      await updateOriginalMessage(
        responseUrl,
        "⚠️ 元メールの threadId を取得できませんでした",
      );
      return;
    }
    const sender = parseFromHeader(original.fromHeader);
    if (!sender.email) {
      await updateOriginalMessage(
        responseUrl,
        "⚠️ 元メールの差出人アドレスを解析できませんでした",
      );
      return;
    }

    // 3) placeholder 展開
    const vars: Record<string, string> = {
      senderName: sender.name || sender.email,
      senderEmail: sender.email,
      originalSubject: original.subjectHeader,
      receivedAt: utcToJstFormat(new Date().toISOString()),
    };
    const renderedSubject = renderTemplate(
      rule.autoReply.subject || "",
      vars,
    ).trim();
    const renderedBody = renderTemplate(rule.autoReply.body || "", vars);
    if (!renderedSubject || !renderedBody.trim()) {
      await updateOriginalMessage(
        responseUrl,
        "⚠️ 自動返信の件名または本文が空のため送信できませんでした",
      );
      return;
    }
    // Re: 前置 (二重 Re: を避けるため、すでに先頭にあるなら付けない)
    const subject = /^(re:|RE:|Re:)/.test(renderedSubject)
      ? renderedSubject
      : `Re: ${renderedSubject}`;

    // 4) 送信
    await sendGmailReply(env, v.gmailAccountId, {
      threadId: original.threadId,
      toAddress: original.fromHeader || sender.email,
      fromAddress: account.email,
      inReplyToMessageId: original.messageIdHeader,
      subject,
      body: renderedBody,
    });

    // 5) Slack message を「送信済」表示に更新
    await updateOriginalMessage(
      responseUrl,
      `✅ <@${actorUserId}> が自動返信を送信しました\n宛先: ${sender.email}\n件名: ${subject}`,
    );
  } catch (e) {
    console.error("[gmail-watcher-reply] failed:", e);
    const msg = e instanceof Error ? e.message : String(e);
    await updateOriginalMessage(
      responseUrl,
      `❌ 自動返信の送信に失敗しました: ${msg.slice(0, 200)}`,
    );
  }
}

/** rules + elseRule から ruleId に一致する rule を返す。 */
function findRuleById(
  cfg: ReturnType<typeof parseWatcherConfig>,
  ruleId: string,
): WatcherRule | null {
  if (!cfg) return null;
  for (const r of cfg.rules) {
    if (r.id === ruleId) return r;
  }
  if (cfg.elseRule && cfg.elseRule.id === ruleId) return cfg.elseRule;
  return null;
}

/**
 * response_url に POST して original message を text-only に更新する。
 * replace_original=true で「ボタンも消えた状態」にする。
 * response_url は 30 分有効。失敗しても fail-soft (log のみ)。
 */
async function updateOriginalMessage(
  responseUrl: string | null,
  text: string,
): Promise<void> {
  if (!responseUrl) return;
  try {
    await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replace_original: true,
        text,
        // blocks を空配列にせず、明示的に section block 1 つにすることで
        // Slack 側で「テキストだけ・ボタン無し」のレイアウトになる。
        blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
      }),
    });
  } catch (e) {
    console.error("[gmail-watcher-reply] response_url update failed:", e);
  }
}
