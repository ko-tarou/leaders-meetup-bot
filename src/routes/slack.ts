import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import type { Env } from "../types/env";
import { SlackClient } from "../services/slack-api";
import { createPoll, handleVote, closePoll } from "../services/poll";
import { createReminderJob } from "../services/scheduler";
import {
  handleMessageEvent,
  maybeTriggerStickyRepost,
} from "../services/auto-respond";
import { handleMemberJoinedChannel } from "../services/member-welcome";
import { meetings, tasks, taskAssignees } from "../db/schema";
import {
  buildTaskAddModalView,
  buildStickyTaskAddModal,
  jstDateTimeToUtcIso,
} from "../services/devhub-task-modal";
import { buildTaskListBlocks } from "../services/devhub-task-list";
import { scheduleTaskReminders } from "../services/devhub-task-reminder";
import { stickyRepostByChannel } from "../services/sticky-task-board";
import {
  getWorkspaceBySlackTeamId,
  getDecryptedWorkspace,
  createSlackClientForWorkspace,
  type DecryptedWorkspace,
} from "../services/workspace";
import { DEFAULT_WORKSPACE_ID } from "../services/workspace-bootstrap";

type Variables = {
  rawBody: string;
  // ADR-0006 (PR5): 署名検証で確定した workspace。後段ハンドラはこれを正とする。
  workspace: DecryptedWorkspace;
};

const slack = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * 生 body から Slack team_id を抽出する（署名検証前のルーティング目的）。
 *
 * 注意: ここで取り出した team_id はまだ署名検証されていない。
 * 「どの workspace の signing_secret で検証すべきか」を決めるためだけに使い、
 * 検証成功後の payload まで信用しない。
 *
 * 形式判定:
 * - JSON (events API): top-level の team_id
 *   url_verification は team_id を持たないので呼び出し側で別経路 (default ws) を使う
 * - form-encoded:
 *   - slash commands: team_id=T...
 *   - interactions: payload={"team":{"id":"T..."}, ...}
 */
function extractTeamId(rawBody: string, contentType: string): string | null {
  if (contentType.includes("application/json")) {
    try {
      const json = JSON.parse(rawBody);
      if (typeof json?.team_id === "string") return json.team_id;
      return null;
    } catch {
      return null;
    }
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(rawBody);
    const teamIdDirect = params.get("team_id");
    if (teamIdDirect) return teamIdDirect;
    const payloadStr = params.get("payload");
    if (payloadStr) {
      try {
        const payload = JSON.parse(payloadStr);
        if (typeof payload?.team?.id === "string") return payload.team.id;
      } catch {
        return null;
      }
    }
    return null;
  }

  return null;
}

/**
 * 署名検証ミドルウェア (multi-workspace 対応 / ADR-0006)
 *
 * 流れ:
 *  1. raw body から team_id を抽出
 *  2. team_id → workspaces 検索 → 該当 WS の signing_secret で HMAC 検証
 *  3. 該当WSが存在しない or 検証失敗で 401
 *  4. url_verification (events API のセットアップ) は team_id を持たないため
 *     default workspace の signing_secret で検証する例外パス
 */
slack.use("/*", async (c, next) => {
  const signature = c.req.header("x-slack-signature") || "";
  const timestamp = c.req.header("x-slack-request-timestamp") || "";
  const contentType = c.req.header("content-type") || "";
  const body = await c.req.text();

  const teamId = extractTeamId(body, contentType);
  let workspace: DecryptedWorkspace | null = null;

  if (teamId) {
    const ws = await getWorkspaceBySlackTeamId(c.env.DB, teamId);
    if (!ws) {
      // 未登録の team からの webhook は即拒否（DoS / timing attack 軽減）
      return c.json({ error: `unknown team_id: ${teamId}` }, 401);
    }
    workspace = await getDecryptedWorkspace(c.env, ws.id);
    if (!workspace) {
      return c.json({ error: "failed to decrypt workspace tokens" }, 500);
    }
  } else {
    // team_id 無し: events API の url_verification が該当する。
    // Slack App セットアップ時のチャレンジは default workspace で検証する。
    if (contentType.includes("application/json")) {
      try {
        const json = JSON.parse(body);
        if (json?.type === "url_verification") {
          workspace = await getDecryptedWorkspace(c.env, DEFAULT_WORKSPACE_ID);
        }
      } catch {
        // フォールスルーして 401
      }
    }
    if (!workspace) {
      return c.json({ error: "team_id not found in payload" }, 401);
    }
  }

  // 該当WSの signing_secret で HMAC 検証
  const verifier = new SlackClient(workspace.botToken, workspace.signingSecret);
  const isValid = await verifier.verifySignature(signature, timestamp, body);
  if (!isValid) {
    return c.json({ error: "invalid signature" }, 401);
  }

  c.set("rawBody", body);
  c.set("workspace", workspace);
  await next();
});

slack.post("/events", async (c) => {
  const body = JSON.parse(c.get("rawBody"));
  if (body.type === "url_verification") {
    return c.json({ challenge: body.challenge });
  }

  if (body.type === "event_callback" && body.event?.type === "message") {
    const client = new SlackClient(
      c.env.SLACK_BOT_TOKEN,
      c.env.SLACK_SIGNING_SECRET,
    );
    // Slack Events APIは3秒以内にレスポンスが必要なので waitUntil でバックグラウンド処理
    c.executionCtx.waitUntil(
      handleMessageEvent(c.env.DB, client, body.event).catch((e) => {
        console.error("Failed to handle message event:", e);
      }),
    );
    // ADR-0006 sticky board repost トリガー（10秒デバウンス）。
    // handleMessageEvent とは独立して走らせる（auto-respond の成否に関係なく動く）。
    maybeTriggerStickyRepost(c.env, c.executionCtx, body.event);
  }

  // ADR-0008: member_joined_channel イベント
  // event_actions の member_welcome 設定があれば、運営チャンネルへ自動招待 + 案内 DM
  if (
    body.type === "event_callback" &&
    body.event?.type === "member_joined_channel"
  ) {
    c.executionCtx.waitUntil(
      handleMemberJoinedChannel(c.env, body.event).catch((e) => {
        console.error("Failed to handle member_joined_channel:", e);
      }),
    );
  }

  return c.json({ ok: true });
});

slack.post("/commands", async (c) => {
  const rawBody = c.get("rawBody");
  const params = new URLSearchParams(rawBody);
  const command = params.get("command");
  const text = params.get("text") || "";
  const channelId = params.get("channel_id") || "";

  if (command === "/meetup") {
    if (text.trim() === "close") {
      const client = new SlackClient(c.env.SLACK_BOT_TOKEN, c.env.SLACK_SIGNING_SECRET);
      try {
        await closePoll(c.env.DB, client, channelId);
        return c.json({
          response_type: "ephemeral",
          text: "投票を締め切りました。結果を送信しました。",
        });
      } catch (error) {
        console.error("Failed to close poll:", error);
        return c.json({
          response_type: "ephemeral",
          text: `投票の締め切りに失敗しました: ${error instanceof Error ? error.message : "不明なエラー"}`,
        });
      }
    }

    if (text.trim().startsWith("remind ")) {
      const parts = text.trim().replace("remind ", "").split(/\s+/);
      const date = parts[0];
      const time = parts[1] || "09:00";

      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return c.json({
          response_type: "ephemeral",
          text: "日付の形式が正しくありません。YYYY-MM-DD形式で入力してください。",
        });
      }

      if (!/^\d{2}:\d{2}$/.test(time)) {
        return c.json({
          response_type: "ephemeral",
          text: "時刻の形式が正しくありません。HH:MM形式で入力してください。",
        });
      }

      const d1 = drizzle(c.env.DB);
      const meeting = await d1
        .select()
        .from(meetings)
        .where(eq(meetings.channelId, channelId))
        .get();

      if (!meeting) {
        return c.json({
          response_type: "ephemeral",
          text: "このチャンネルにはミーティングが設定されていません。先に `/meetup` で投票を作成してください。",
        });
      }

      const runAt = `${date}T${time}:00.000Z`;
      await createReminderJob(c.env.DB, meeting.id, runAt);

      return c.json({
        response_type: "ephemeral",
        text: `リマインドを設定しました: ${date} ${time} (UTC)`,
      });
    }

    const dates = text.trim().split(/\s+/).filter(Boolean);

    if (dates.length === 0) {
      return c.json({
        response_type: "ephemeral",
        text: "使い方:\n`/meetup 2026-04-20 2026-04-27` - 日程調整の投票を作成\n`/meetup close` - 現在の投票を締め切り、結果を表示\n`/meetup remind 2026-04-20 09:00` - リマインドを設定",
      });
    }

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    const invalidDates = dates.filter((d) => !dateRegex.test(d));
    if (invalidDates.length > 0) {
      return c.json({
        response_type: "ephemeral",
        text: `日付の形式が正しくありません: ${invalidDates.join(", ")}\nYYYY-MM-DD形式で入力してください。`,
      });
    }

    const client = new SlackClient(
      c.env.SLACK_BOT_TOKEN,
      c.env.SLACK_SIGNING_SECRET,
    );

    try {
      await createPoll(c.env.DB, client, channelId, "リーダー雑談会", dates);
      return c.json({
        response_type: "ephemeral",
        text: "日程調整の投票を作成しました！",
      });
    } catch (error) {
      console.error("Failed to create poll:", error);
      return c.json({
        response_type: "ephemeral",
        text: "投票の作成に失敗しました。もう一度お試しください。",
      });
    }
  }

  if (command === "/devhub") {
    const trimmed = text.trim();

    // /devhub task list [all] — 自分担当の未完了タスク一覧（"all" で全件）
    if (trimmed === "task list" || trimmed.startsWith("task list ")) {
      const userId = params.get("user_id") || "";
      const d1 = drizzle(c.env.DB);

      const meeting = await d1
        .select()
        .from(meetings)
        .where(eq(meetings.channelId, channelId))
        .get();

      if (!meeting || !meeting.eventId) {
        return c.json({
          response_type: "ephemeral",
          text: "このチャンネルに紐付いたイベントがありません。",
        });
      }

      const filterText = trimmed.replace(/^task list\s*/, "").trim();
      const showAll = filterText === "all";

      let userTaskIds: Set<string> | null = null;
      if (!showAll) {
        const userAssignees = await d1
          .select()
          .from(taskAssignees)
          .where(eq(taskAssignees.slackUserId, userId))
          .all();
        userTaskIds = new Set(userAssignees.map((a) => a.taskId));
      }

      let taskList = await d1
        .select()
        .from(tasks)
        .where(eq(tasks.eventId, meeting.eventId))
        .all();

      if (!showAll && userTaskIds) {
        taskList = taskList.filter((t) => userTaskIds!.has(t.id));
      }
      taskList = taskList.filter((t) => t.status !== "done");
      taskList.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

      if (taskList.length === 0) {
        return c.json({
          response_type: "ephemeral",
          text: showAll
            ? "未完了のタスクはありません。"
            : "あなた担当の未完了タスクはありません。`/devhub task list all` で全件表示。",
        });
      }

      const blocks = buildTaskListBlocks(taskList);
      return c.json({ response_type: "ephemeral", blocks });
    }

    const isTaskAdd =
      trimmed === "task" ||
      trimmed === "task add" ||
      trimmed.startsWith("task add");

    if (isTaskAdd) {
      const triggerId = params.get("trigger_id");
      if (!triggerId) {
        return c.json({
          response_type: "ephemeral",
          text: "trigger_id がありません。",
        });
      }

      const userId = params.get("user_id") || "";
      const d1 = drizzle(c.env.DB);
      const meeting = await d1
        .select()
        .from(meetings)
        .where(eq(meetings.channelId, channelId))
        .get();

      if (!meeting || !meeting.eventId) {
        return c.json({
          response_type: "ephemeral",
          text: "このチャンネルに紐付いたイベントが見つかりません。先に Web UI でイベント・ミーティングを作成してください。",
        });
      }

      const client = new SlackClient(
        c.env.SLACK_BOT_TOKEN,
        c.env.SLACK_SIGNING_SECRET,
      );
      const view = buildTaskAddModalView({
        eventId: meeting.eventId,
        channelId,
        createdBySlackId: userId,
      });

      // views.open は trigger_id の有効期限が3秒のため waitUntil で即時に発火
      c.executionCtx.waitUntil(
        client
          .openView(triggerId, view)
          .then((res) => {
            if (!res.ok) {
              console.error("views.open returned not ok:", res);
            }
          })
          .catch((e) => {
            console.error("Failed to open task add modal:", e);
          }),
      );

      return c.json({ response_type: "ephemeral", text: "" });
    }

    return c.json({
      response_type: "ephemeral",
      text: "使い方:\n`/devhub task add` - タスクを作成\n`/devhub task list` - 自分担当の未完了タスク一覧\n`/devhub task list all` - チャンネル内の全未完了タスク",
    });
  }

  return c.json({
    response_type: "ephemeral",
    text: "不明なコマンドです。",
  });
});

slack.post("/interactions", async (c) => {
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
  }

  if (payload.type === "view_submission") {
    const view = payload.view;
    if (view?.callback_id === "devhub_task_add_submit") {
      let meta: {
        eventId?: string;
        channelId?: string;
        createdBySlackId?: string;
      } = {};
      try {
        meta = JSON.parse(view.private_metadata || "{}");
      } catch {
        meta = {};
      }
      const eventId = meta.eventId;
      const channelId = meta.channelId || "";
      const createdBySlackId =
        meta.createdBySlackId || payload.user?.id || "";

      const values = view.state?.values || {};
      const title: string | undefined =
        values.title_block?.title_input?.value;
      const description: string | null =
        values.desc_block?.desc_input?.value || null;
      const assigneeIds: string[] =
        values.assignees_block?.assignees_input?.selected_users || [];
      const dueDate: string | null =
        values.due_date_block?.due_date_input?.selected_date || null;
      const dueTime: string | null =
        values.due_time_block?.due_time_input?.selected_time || null;
      const priority: string =
        values.priority_block?.priority_input?.selected_option?.value || "mid";

      if (!title || !title.trim()) {
        return c.json({
          response_action: "errors",
          errors: { title_block: "タスク名は必須です" },
        });
      }
      if (!eventId) {
        return c.json({
          response_action: "errors",
          errors: {
            title_block:
              "イベント情報が失われています。コマンドを再実行してください。",
          },
        });
      }

      const dueAt: string | null = dueDate
        ? jstDateTimeToUtcIso(dueDate, dueTime)
        : null;

      // モーダル送信は3秒以内に応答必須。実処理は waitUntil でバックグラウンド化
      c.executionCtx.waitUntil(
        (async () => {
          const client = new SlackClient(
            c.env.SLACK_BOT_TOKEN,
            c.env.SLACK_SIGNING_SECRET,
          );
          const d1 = drizzle(c.env.DB);
          try {
            const taskId = crypto.randomUUID();
            const now = new Date().toISOString();
            await d1.insert(tasks).values({
              id: taskId,
              eventId,
              parentTaskId: null,
              title,
              description,
              dueAt,
              status: "todo",
              priority,
              createdBySlackId,
              createdAt: now,
              updatedAt: now,
            });

            for (const slackUserId of assigneeIds) {
              await d1.insert(taskAssignees).values({
                id: crypto.randomUUID(),
                taskId,
                slackUserId,
                assignedAt: now,
              });
            }

            // dueAt があり担当者が居るならリマインドジョブを登録（前日/当日 09:00 JST）
            if (dueAt && assigneeIds.length > 0) {
              try {
                await scheduleTaskReminders(
                  c.env.DB,
                  taskId,
                  dueAt,
                  title,
                  assigneeIds,
                );
              } catch (remErr) {
                // リマインド登録の失敗はタスク作成自体の成否を左右しない
                console.error(
                  "Failed to schedule devhub task reminders:",
                  remErr,
                );
              }
            }

            const successText = `✅ タスクを作成しました: ${title}`;
            if (channelId) {
              await client.postEphemeral(
                channelId,
                createdBySlackId,
                successText,
              );
            } else {
              await client.postMessage(createdBySlackId, successText);
            }
          } catch (e) {
            console.error("Failed to create task from modal:", e);
            const failText = `⚠️ タスク作成に失敗しました: ${
              e instanceof Error ? e.message : "unknown"
            }`;
            try {
              await client.postMessage(createdBySlackId, failText);
            } catch (notifyErr) {
              console.error("Failed to notify task failure:", notifyErr);
            }
          }
        })(),
      );

      // モーダルを閉じる
      return c.json({});
    }

    // === ADR-0006 sticky board: タスク作成モーダルのサブミット ===
    // 既存 devhub_task_add_submit の処理ロジックに加え、最後に sticky board を
    // 即時 repost する（ボードに新しいタスクが見えるようにする）。
    // 既存ハンドラを共通化はせず、PR スコープを最小化する方針（後続 PR で DRY 化）。
    if (view?.callback_id === "sticky_task_add_submit") {
      let meta: {
        eventId?: string;
        channelId?: string;
        createdBySlackId?: string;
      } = {};
      try {
        meta = JSON.parse(view.private_metadata || "{}");
      } catch {
        meta = {};
      }
      const eventId = meta.eventId;
      const channelId = meta.channelId || "";
      const createdBySlackId =
        meta.createdBySlackId || payload.user?.id || "";

      const values = view.state?.values || {};
      const title: string | undefined =
        values.title_block?.title_input?.value;
      const description: string | null =
        values.desc_block?.desc_input?.value || null;
      const assigneeIds: string[] =
        values.assignees_block?.assignees_input?.selected_users || [];
      const dueDate: string | null =
        values.due_date_block?.due_date_input?.selected_date || null;
      const dueTime: string | null =
        values.due_time_block?.due_time_input?.selected_time || null;
      const priority: string =
        values.priority_block?.priority_input?.selected_option?.value || "mid";

      if (!title || !title.trim()) {
        return c.json({
          response_action: "errors",
          errors: { title_block: "タスク名は必須です" },
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

      const dueAt: string | null = dueDate
        ? jstDateTimeToUtcIso(dueDate, dueTime)
        : null;

      c.executionCtx.waitUntil(
        (async () => {
          const client = new SlackClient(
            c.env.SLACK_BOT_TOKEN,
            c.env.SLACK_SIGNING_SECRET,
          );
          const d1 = drizzle(c.env.DB);
          try {
            const taskId = crypto.randomUUID();
            const now = new Date().toISOString();
            await d1.insert(tasks).values({
              id: taskId,
              eventId,
              parentTaskId: null,
              title,
              description,
              dueAt,
              status: "todo",
              priority,
              createdBySlackId,
              createdAt: now,
              updatedAt: now,
            });

            for (const slackUserId of assigneeIds) {
              await d1.insert(taskAssignees).values({
                id: crypto.randomUUID(),
                taskId,
                slackUserId,
                assignedAt: now,
              });
            }

            if (dueAt && assigneeIds.length > 0) {
              try {
                await scheduleTaskReminders(
                  c.env.DB,
                  taskId,
                  dueAt,
                  title,
                  assigneeIds,
                );
              } catch (remErr) {
                console.error(
                  "Failed to schedule sticky task reminders:",
                  remErr,
                );
              }
            }

            // sticky board を即時 repost してボード上に新タスクを反映
            if (channelId) {
              try {
                await stickyRepostByChannel(c.env, channelId);
              } catch (repErr) {
                console.error("Failed to repost sticky board after create:", repErr);
              }
            }

            const successText = `✅ タスクを作成しました: ${title}`;
            if (channelId) {
              await client.postEphemeral(
                channelId,
                createdBySlackId,
                successText,
              );
            } else {
              await client.postMessage(createdBySlackId, successText);
            }
          } catch (e) {
            console.error("Failed to create sticky task from modal:", e);
            const failText = `⚠️ タスク作成に失敗しました: ${
              e instanceof Error ? e.message : "unknown"
            }`;
            try {
              await client.postMessage(createdBySlackId, failText);
            } catch (notifyErr) {
              console.error("Failed to notify sticky task failure:", notifyErr);
            }
          }
        })(),
      );

      return c.json({});
    }
  }

  return c.json({ ok: true });
});

export { slack };
