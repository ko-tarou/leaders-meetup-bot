import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq, and, ne } from "drizzle-orm";
import type { Env } from "../../types/env";
import { handleVote } from "../../services/poll";
import {
  handleAttendanceVote,
  type AttendanceChoice,
} from "../../services/attendance-check";
import { handleMorningAttend } from "../../services/morning-standup";
import {
  handleKejimeArticleLgtm,
  processQiitaArticleSubmission,
} from "../../services/kejime-article-flow";
import { buildKejimeArticleModal } from "../../services/kejime-article-modal";
import { drawPendingGacha } from "../../services/kejime-gacha-draw";
import { postOrUpdateKejimeStatus } from "../../services/kejime-status-post";
import {
  meetings,
  tasks,
  taskAssignees,
  prReviews,
  prReviewLgtms,
  prReviewReviewers,
} from "../../db/schema";
import {
  buildStickyTaskAddModal,
  buildPRReviewAddModal,
  buildPRReviewEditModal,
  handleTaskAddSubmission,
  PR_REVIEW_MAX_REVIEWERS,
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
import { renderTemplate } from "../../domain/email/template";
import { getJstNow, utcToJstFormat } from "../../services/time-utils";

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

    // 003 朝勉強会けじめ制度 PR2: 朝活「参加」ボタン。
    // action_id = morning_attend:<eventActionId>:<YYYYMMDD>
    if (action.action_id?.startsWith("morning_attend:")) {
      const userId = payload.user?.id;
      const responseUrl: string | null = payload.response_url ?? null;
      const messageTs: string | null = payload.message?.ts ?? null;
      const parts = action.action_id.split(":");
      if (!userId || parts.length !== 3) return c.json({ ok: true });
      c.executionCtx.waitUntil((async () => {
        try {
          const res = await handleMorningAttend(c.env.DB, {
            eventActionId: parts[1], ymdCompact: parts[2],
            slackUserId: userId, messageTs,
          });
          if (responseUrl) {
            await fetch(responseUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                response_type: "ephemeral", replace_original: false, text: res.text,
              }),
            });
          }
        } catch (e) {
          console.error("Failed to handle morning_attend:", e);
        }
      })());
      return c.json({ ok: true });
    }

    // 003 朝勉強会けじめ制度 PR14: けじめ ch の「📝 記事を申請」ボタン。
    // action_id = kejime_article_submit:<trackerActionId>
    // → Slack views.open で URL 入力モーダルを開く。trigger_id は 3 秒で失効
    // するため waitUntil 内でも極力早く openView を叩く。
    if (action.action_id?.startsWith("kejime_article_submit:")) {
      const actionId = action.action_id.split(":")[1];
      const triggerId = payload.trigger_id;
      if (!actionId || !triggerId) return c.json({ ok: true });
      c.executionCtx.waitUntil((async () => {
        try {
          const client = getSlackClient(c);
          const res = await client.openView(
            triggerId, buildKejimeArticleModal(actionId),
          );
          if (!res.ok) {
            console.error("kejime_article_submit views.open not ok:", res);
          }
        } catch (e) {
          console.error("Failed to open kejime article modal:", e);
        }
      })());
      return c.json({ ok: true });
    }

    // けじめ記事 LGTM ボタン (リアクション承認からの移行先)。
    // action_id = kejime_article_lgtm:<requestId>
    // → トグルで LGTM を加減し、閾値到達で記事を承認する。waitUntil で非同期処理。
    if (action.action_id?.startsWith("kejime_article_lgtm:")) {
      const requestId =
        action.action_id.slice("kejime_article_lgtm:".length) ||
        (action.value as string | undefined) || "";
      const userId = payload.user?.id;
      const channelId = payload.channel?.id;
      const responseUrl: string | null = payload.response_url ?? null;
      if (!requestId || !userId || !channelId) return c.json({ ok: true });
      c.executionCtx.waitUntil((async () => {
        try {
          const client = getSlackClient(c);
          const res = await handleKejimeArticleLgtm(c.env.DB, client, {
            requestId, slackUserId: userId, channelId,
          });
          // 出席ボタン (attendance/morning_attend) と同様、押した本人にだけ
          // ephemeral で確認を返す。トグル方向で文言を変える。
          if (res && responseUrl) {
            const text = res.action === "added"
              ? `LGTM しました (${res.count}/${res.threshold})`
              : `LGTM を取り消しました (${res.count}/${res.threshold})`;
            await fetch(responseUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                response_type: "ephemeral", replace_original: false, text,
              }),
            });
          }
        } catch (e) {
          console.error("Failed to handle kejime_article_lgtm:", e);
        }
      })());
      return c.json({ ok: true });
    }

    // 朝勉強会けじめ制度 (PR#315 改修 / 仕様訂正): 遅刻ガチャ「誰でも引ける」ボタン。
    // action_id = kejime_gacha_draw:<penaltyId>
    // → サーバー側で 1〜3pt を抽選 (crypto・改ざん不可)、pending -> open へ
    //   atomic 遷移 (二重抽選防止)。遅刻者本人に限らず誰でも押せる。
    //   結果は簡単な演出 (ドラムロール -> リビール) で押した人に ephemeral 表示し、
    //   確定後に当日ステータスを最新化する。ポイントは遅刻者本人に加算される。
    if (action.action_id?.startsWith("kejime_gacha_draw:")) {
      const penaltyId = action.action_id.slice("kejime_gacha_draw:".length)
        || (action.value as string | undefined) || "";
      const userId = payload.user?.id as string | undefined;
      const channelId = payload.channel?.id as string | undefined;
      if (!penaltyId || !userId) return c.json({ ok: true });
      c.executionCtx.waitUntil((async () => {
        const client = getSlackClient(c);
        try {
          const result = await drawPendingGacha(c.env.DB, penaltyId, userId);
          if (channelId) {
            if (result.ok) {
              // 演出: ドラムロール -> リビール (2 通の ephemeral)。
              await client.postEphemeral(
                channelId, userId, "🎲 ガチャを回しています... ドゥルルルル...",
              ).catch(() => undefined);
              await client.postEphemeral(
                channelId, userId,
                `🎉 *${"⭐".repeat(result.points)} ${result.points}pt!* ` +
                  `(${result.date} の遅刻 / 記事 ${result.requiredChars}字)\n` +
                  `現在 ${result.displayPoints}pt。記事を書いて消化しましょう。`,
              ).catch(() => undefined);
            } else {
              const msg = result.reason === "already_drawn"
                ? "このガチャは既に抽選済みです。"
                : "ガチャ対象が見つかりませんでした。";
              await client.postEphemeral(channelId, userId, msg).catch(() => undefined);
            }
          }
          // 抽選でポイント / pending が変動したのでステータスを更新 (fail-soft)。
          if (result.ok) {
            await postOrUpdateKejimeStatus(
              c.env.DB, client, result.trackerActionId, getJstNow().ymd,
            ).catch(() => undefined);
          }
        } catch (e) {
          console.error("Failed to draw kejime gacha:", e);
        }
      })());
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
    //
    // board 直下の単体ボタンは BE PR1 で撤去したが、編集モーダル内のアクション
    // から再利用される。board 文脈では action.value = reviewId（旧仕様。残し）、
    // モーダル文脈では action.value = JSON({reviewId, channelId})。modal 文脈は
    // payload.channel が無いため value JSON から channelId を解決し、完了後に
    // モーダルを結果表示に差し替える（views.update）。
    if (action.action_id?.startsWith("sticky_pr_done_")) {
      const ctx = resolveStickyPrActionContext(action, payload);
      if (!ctx.reviewId || !ctx.channelId) return c.json({ ok: true });
      const { reviewId, channelId } = ctx;
      const viewId: string | undefined = payload.view?.id;

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
            if (viewId) {
              await closeStickyPrModal(
                c,
                viewId,
                "✅ レビュー依頼を完了にしました。",
              );
            }
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
    // board 直下の単体ボタンは BE PR1 で撤去。編集モーダル内アクションから
    // 再利用する。reRequestReview 内で board repost まで実施されるため、
    // ここでは二重 repost しない（既存挙動を維持）。modal 文脈なら完了後に
    // モーダルを結果表示へ差し替える。
    if (action.action_id?.startsWith("sticky_pr_rereview_")) {
      const ctx = resolveStickyPrActionContext(action, payload);
      if (!ctx.reviewId) return c.json({ ok: true });
      const { reviewId } = ctx;
      const viewId: string | undefined = payload.view?.id;

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
            if (viewId) {
              await closeStickyPrModal(
                c,
                viewId,
                "🔄 再レビュー依頼を送信しました。",
              );
            }
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

    // sticky_pr_comment_<reviewId>: 「💬 コメント」ボタン。
    // 入力モーダルは出さず、即:
    //   1. status='changes_requested' に UPDATE（board で「🔧 修正依頼中」表示・
    //      未完了として一覧に残る）
    //   2. 依頼者へチャンネルでメンション通知（押下者=reviewer をメンション）
    //   3. board repost
    // LGTM には一切カウントしない（prReviewLgtms に触れない）。
    // fail-soft: 既存 sticky_pr_* と同じ ack 作法。失敗はログのみ。
    if (action.action_id?.startsWith("sticky_pr_comment_")) {
      const reviewId = action.value;
      const reviewerId = payload.user?.id;
      const channelId = payload.channel?.id;
      if (!reviewId || !reviewerId || !channelId) {
        return c.json({ ok: true });
      }

      c.executionCtx.waitUntil(
        (async () => {
          try {
            const d1 = drizzle(c.env.DB);
            const review = await d1
              .select()
              .from(prReviews)
              .where(eq(prReviews.id, reviewId))
              .get();
            if (!review) {
              console.warn(
                `sticky_pr_comment: review ${reviewId} not found`,
              );
              return;
            }
            await d1
              .update(prReviews)
              .set({
                status: "changes_requested",
                updatedAt: new Date().toISOString(),
              })
              .where(eq(prReviews.id, reviewId));

            // 依頼者へチャンネルでメンション通知（fail-soft）
            try {
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
                  const message = `<@${review.requesterSlackId}> 🔧 <@${reviewerId}> さんが修正を希望しています: ${review.title}`;
                  await client.postMessage(channelId, message);
                }
              }
            } catch (e) {
              console.warn(
                "sticky_pr_comment notify failed (fail-soft):",
                e,
              );
            }

            await prReviewRepostByChannel(c.env, channelId);
          } catch (e) {
            console.error("Failed to handle sticky_pr_comment:", e);
          }
        })(),
      );

      return c.json({ ok: true });
    }

    // sticky_pr_edit_<reviewId>: 「✏️ 編集」ボタン → 編集モーダル open。
    // trigger_id は 3 秒で失効するため waitUntil 内でも極力早く openView。
    if (action.action_id?.startsWith("sticky_pr_edit_")) {
      const reviewId = action.value;
      const triggerId = payload.trigger_id;
      const channelId = payload.channel?.id;
      if (!reviewId || !triggerId || !channelId) {
        return c.json({ ok: true });
      }

      c.executionCtx.waitUntil(
        (async () => {
          try {
            const d1 = drizzle(c.env.DB);
            const review = await d1
              .select()
              .from(prReviews)
              .where(eq(prReviews.id, reviewId))
              .get();
            if (!review) {
              console.warn(`sticky_pr_edit: review ${reviewId} not found`);
              return;
            }
            const reviewerRows = await d1
              .select()
              .from(prReviewReviewers)
              .where(eq(prReviewReviewers.reviewId, reviewId))
              .all();
            const meeting = await d1
              .select()
              .from(meetings)
              .where(eq(meetings.channelId, channelId))
              .get();
            if (!meeting || !meeting.workspaceId) {
              console.warn(
                `sticky_pr_edit: meeting/workspace not found for channel ${channelId}`,
              );
              return;
            }
            const client = await createSlackClientForWorkspace(
              c.env,
              meeting.workspaceId,
            );
            if (!client) {
              console.warn(
                `sticky_pr_edit: no SlackClient for workspace ${meeting.workspaceId}`,
              );
              return;
            }
            const view = buildPRReviewEditModal({
              reviewId,
              eventId: review.eventId,
              channelId,
              title: review.title,
              url: review.url,
              description: review.description,
              reviewerSlackIds: reviewerRows.map((r) => r.slackUserId),
            });
            const res = await client.openView(triggerId, view);
            if (!res.ok) {
              console.error(
                "sticky_pr_edit views.open returned not ok:",
                res,
              );
            }
          } catch (e) {
            console.error("Failed to open sticky_pr_edit modal:", e);
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

    // 003 朝勉強会けじめ制度 PR14: 記事申請モーダルの submit。
    // callback_id = kejime_article_modal:<trackerActionId>
    // URL を取り出して processQiitaArticleSubmission に委譲。waitUntil で非同期処理し、
    // response_action: "clear" でモーダルを即閉じる (3 秒 ack 制約)。
    if (view?.callback_id?.startsWith("kejime_article_modal:")) {
      const actionId = view.callback_id.split(":")[1];
      const url: string | undefined =
        view.state?.values?.url_block?.url_input?.value;
      const slackUserId: string | undefined = payload.user?.id;
      if (!actionId || !url || !url.trim() || !slackUserId) {
        return c.json({
          response_action: "errors",
          errors: { url_block: "URL を入力してください" },
        });
      }
      c.executionCtx.waitUntil((async () => {
        try {
          const client = getSlackClient(c);
          await processQiitaArticleSubmission(c.env.DB, client, fetch, {
            actionId, slackUserId, url: url.trim(),
          });
        } catch (e) {
          console.error("kejime article modal submit failed:", e);
        }
      })());
      return c.json({ response_action: "clear" });
    }

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
      // 複数レビュアー対応（multi_users_select）。最大 5 に切り詰める。
      const reviewerSlackIds: string[] = (
        values.reviewer_block?.reviewer_input?.selected_users || []
      ).slice(0, PR_REVIEW_MAX_REVIEWERS);

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
            const initialStatus =
              reviewerSlackIds.length > 0 ? "in_review" : "open";
            const reviewInsert = d1.insert(prReviews).values({
              id: reviewId,
              eventId,
              title,
              url,
              description,
              status: initialStatus,
              requesterSlackId,
              // 旧 dead column。新コードは prReviewReviewers を正とするが
              // 既存挙動互換のため先頭1人を入れておく（参照はしない）。
              reviewerSlackId: reviewerSlackIds[0] ?? null,
              createdAt: now,
              updatedAt: now,
            });
            const reviewerRows = reviewerSlackIds.map((slackUserId) => ({
              id: crypto.randomUUID(),
              reviewId,
              slackUserId,
              createdAt: now,
            }));
            // review 本体と reviewers を 1 トランザクションで INSERT
            // （途中失敗で中途半端な状態を残さない）。
            if (reviewerRows.length > 0) {
              await d1.batch([
                reviewInsert,
                d1.insert(prReviewReviewers).values(reviewerRows),
              ]);
            } else {
              await reviewInsert;
            }

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
                reviewerSlackIds,
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

    // === Slack 完結 BE PR1: PR レビュー編集モーダルのサブミット ===
    // title/description/url を UPDATE、prReviewReviewers を選択値で置換
    // （全削除 → 挿入の idempotent。最大5に切り詰め）→ board repost。
    if (view?.callback_id === "sticky_pr_review_edit_submit") {
      let meta: {
        reviewId?: string;
        eventId?: string;
        channelId?: string;
      } = {};
      try {
        meta = JSON.parse(view.private_metadata || "{}");
      } catch {
        meta = {};
      }
      const reviewId = meta.reviewId;
      const channelId = meta.channelId || "";

      const values = view.state?.values || {};
      const title: string | undefined =
        values.title_block?.title_input?.value;
      const url: string | null = values.url_block?.url_input?.value || null;
      const description: string | null =
        values.desc_block?.desc_input?.value || null;
      const reviewerSlackIds: string[] = (
        values.reviewer_block?.reviewer_input?.selected_users || []
      ).slice(0, PR_REVIEW_MAX_REVIEWERS);

      if (!title || !title.trim()) {
        return c.json({
          response_action: "errors",
          errors: { title_block: "タイトルは必須です" },
        });
      }
      if (!reviewId) {
        return c.json({
          response_action: "errors",
          errors: {
            title_block:
              "レビュー情報が失われています。ボードの編集ボタンを押し直してください。",
          },
        });
      }

      c.executionCtx.waitUntil(
        (async () => {
          const d1 = drizzle(c.env.DB);
          try {
            await d1
              .update(prReviews)
              .set({
                title,
                url,
                description,
                updatedAt: new Date().toISOString(),
              })
              .where(eq(prReviews.id, reviewId));

            // reviewers を全削除 → 再挿入（idempotent 置換）。
            const now = new Date().toISOString();
            const reviewerRows = reviewerSlackIds.map((slackUserId) => ({
              id: crypto.randomUUID(),
              reviewId,
              slackUserId,
              createdAt: now,
            }));
            const delStmt = d1
              .delete(prReviewReviewers)
              .where(eq(prReviewReviewers.reviewId, reviewId));
            if (reviewerRows.length > 0) {
              await d1.batch([
                delStmt,
                d1.insert(prReviewReviewers).values(reviewerRows),
              ]);
            } else {
              await delStmt;
            }

            if (channelId) {
              await prReviewRepostByChannel(c.env, channelId);
            }
          } catch (e) {
            console.error(
              "Failed to edit pr review from sticky modal:",
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
// Slack 完結 BE PR1: 編集モーダル内アクション共通ヘルパー
// =============================================================================

/**
 * sticky_pr_done_* / sticky_pr_rereview_* の文脈解決。
 *
 * - board 直下ボタン（旧仕様。BE PR1 で撤去済みだが後方互換で残す）:
 *   action.value = reviewId（プレーン文字列）、channelId は payload.channel.id
 * - 編集モーダル内ボタン: action.value = JSON({reviewId, channelId})。
 *   モーダル文脈は payload.channel が無いため value から channelId を取る。
 */
function resolveStickyPrActionContext(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  action: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any,
): { reviewId: string | null; channelId: string | null } {
  const raw: string | undefined = action.value;
  if (raw && raw.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as {
        reviewId?: string;
        channelId?: string;
      };
      return {
        reviewId: parsed.reviewId || null,
        channelId:
          parsed.channelId || payload.channel?.id || null,
      };
    } catch {
      // fallthrough to plain-string handling
    }
  }
  return {
    reviewId: raw || null,
    channelId: payload.channel?.id || null,
  };
}

/**
 * 編集モーダル内アクション完了後にモーダルを結果表示へ差し替える。
 * fail-soft: workspace / view 解決失敗・API 失敗でも warn のみ。
 */
async function closeStickyPrModal(
  c: Parameters<typeof getSlackClient>[0],
  viewId: string,
  message: string,
): Promise<void> {
  try {
    const client = getSlackClient(c);
    await client.updateView(viewId, {
      type: "modal",
      callback_id: "sticky_pr_review_result",
      title: { type: "plain_text", text: "完了" },
      close: { type: "plain_text", text: "閉じる" },
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: message },
        },
      ],
    });
  } catch (e) {
    console.warn("closeStickyPrModal failed (fail-soft):", e);
  }
}

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
