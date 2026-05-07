import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq, and, ne } from "drizzle-orm";
import type { Env } from "../../types/env";
import { SlackClient } from "../../services/slack-api";
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
  LGTM_THRESHOLD,
} from "../../services/sticky-pr-review-board";
import { createSlackClientForWorkspace } from "../../services/workspace";
import type { SlackVariables } from "./utils";

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

      const client = new SlackClient(c.env.SLACK_BOT_TOKEN, c.env.SLACK_SIGNING_SECRET);
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
          const client = new SlackClient(
            c.env.SLACK_BOT_TOKEN,
            c.env.SLACK_SIGNING_SECRET,
          );
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
          const client = new SlackClient(
            c.env.SLACK_BOT_TOKEN,
            c.env.SLACK_SIGNING_SECRET,
          );
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

              // LGTM 数を確認（しきい値は sticky-pr-review-board.ts と共通定数を参照）
              const lgtms = await d1
                .select()
                .from(prReviewLgtms)
                .where(eq(prReviewLgtms.reviewId, reviewId))
                .all();

              if (lgtms.length >= LGTM_THRESHOLD) {
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
