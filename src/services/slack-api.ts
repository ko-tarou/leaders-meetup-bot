export type SlackResponse = {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
};

// Sprint 24 (role_management): Slack workspace のユーザー情報。
// users.list / users.info の members[] / user 要素に対応する最小フィールド。
export type SlackUser = {
  id: string;
  name?: string;
  real_name?: string;
  profile?: {
    display_name?: string;
    real_name?: string;
    image_72?: string;
  };
  deleted?: boolean;
  is_bot?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
};

import type { SlackPort } from "./ports/slack-port";

// Phase 1-A: 実装は一切変更せず、現行 public メソッドが SlackPort と
// 厳密一致することを型レベルで保証する（implements がコンパイルを通る
// こと自体が「Port が現状を歪めず写している」ことの機械的証明）。
export class SlackClient implements SlackPort {
  private token: string;
  private signingSecret: string;

  constructor(token: string, signingSecret: string) {
    this.token = token;
    this.signingSecret = signingSecret;
  }

  async postMessage(
    channel: string,
    text: string,
    blocks?: unknown[],
    threadTs?: string,
  ): Promise<SlackResponse> {
    // thread_ts を渡すと既存メッセージのスレッドに返信する。
    // 未指定 (undefined) のときは従来どおりトップレベル投稿 (= byte-identical)。
    return this.callApi("chat.postMessage", {
      channel,
      text,
      blocks,
      thread_ts: threadTs,
    });
  }

  async updateMessage(
    channel: string,
    ts: string,
    text: string,
    blocks?: unknown[],
  ): Promise<SlackResponse> {
    return this.callApi("chat.update", { channel, ts, text, blocks });
  }

  // ADR-0006: sticky task board が「常に最下部」を維持するため、既存メッセージを
  // 削除してから新規 post する。既に削除済み (message_not_found) でも fail-soft
  // で続行できるよう、呼び出し側でエラーを握り潰せるよう SlackResponse をそのまま返す。
  async deleteMessage(channel: string, ts: string): Promise<SlackResponse> {
    return this.callApi("chat.delete", { channel, ts });
  }

  async scheduleMessage(
    channel: string,
    postAt: number,
    text: string,
    blocks?: unknown[],
  ): Promise<SlackResponse> {
    return this.callApi("chat.scheduleMessage", {
      channel,
      post_at: postAt,
      text,
      blocks,
    });
  }

  async deleteScheduledMessage(
    channel: string,
    scheduledMessageId: string,
  ): Promise<SlackResponse> {
    return this.callApi("chat.deleteScheduledMessage", {
      channel,
      scheduled_message_id: scheduledMessageId,
    });
  }

  async addReaction(
    channel: string,
    timestamp: string,
    name: string,
  ): Promise<SlackResponse> {
    return this.callApi("reactions.add", { channel, timestamp, name });
  }

  async openView(triggerId: string, view: unknown): Promise<SlackResponse> {
    return this.callApi("views.open", { trigger_id: triggerId, view });
  }

  // 既に開いている modal を view_id で差し替える（modal 内 block_actions 後に
  // 結果メッセージへ更新する用途）。
  async updateView(viewId: string, view: unknown): Promise<SlackResponse> {
    return this.callApi("views.update", { view_id: viewId, view });
  }

  async postEphemeral(
    channel: string,
    user: string,
    text: string,
    blocks?: unknown[],
  ): Promise<SlackResponse> {
    return this.callApi("chat.postEphemeral", { channel, user, text, blocks });
  }

  async getUserInfo(userId: string): Promise<SlackResponse> {
    return this.callApiGet("users.info", { user: userId });
  }

  /**
   * 名簿 Slack 連携強化 PR1: メールアドレスから Slack ユーザーを引く。
   *
   * 成功時のレスポンスは
   *   { ok: true, user: { id, name, real_name, profile: { display_name, email, ... } } }
   * 失敗時は `{ ok: false, error: "users_not_found" | "invalid_email" | ... }`。
   *
   * 必要 scope: `users:read.email` (display name 解決の `users:read` とは別)。
   * 呼び出し側 (participation 提出 / roster 同期) は fail-soft で扱い、
   * 解決失敗は従来の slack_name 経由 fallback に委ねる。
   */
  async usersLookupByEmail(email: string): Promise<SlackResponse> {
    return this.callApiGet("users.lookupByEmail", { email });
  }

  async getChannelList(opts?: {
    maxPages?: number;
  }): Promise<SlackResponse & { pages?: number; truncated?: boolean }> {
    // conversations.list で workspace の全 public/private チャンネルを取得する。
    // 以前は users.conversations を使っていたが、bot 参加済みチャンネルしか
    // 返らず一覧が欠ける問題があったため切替。private_channel を含めるには
    // bot に groups:read scope が必要（既存付与済み）。
    // 戻り値の channels[].is_member で参加状態は呼び出し側が判定可能。
    //
    // ページネーション対応: limit=200 単発呼び出しでは KIT Developers Hub の
    // ような大規模 workspace で channels が欠ける（next_cursor 未処理）。
    // cursor を辿って最大 MAX_PAGES まで取得する。
    //
    // subrequest 予算対策: 1 回の cursor ページ取得 = 1 subrequest なので、
    // 呼び出し側 (computeSyncDiff 等) が 1 invocation の subrequest 総数を
    // 制御できるよう maxPages を渡せるようにし、実際に消費したページ数 (pages)
    // と、cursor が残ったまま maxPages で打ち切ったか (truncated) を返す。
    const allChannels: unknown[] = [];
    let cursor = "";
    let pages = 0;
    const MAX_PAGES = Math.max(1, opts?.maxPages ?? 20);

    while (pages < MAX_PAGES) {
      const params: Record<string, string | number> = {
        limit: 200,
        types: "public_channel,private_channel",
        exclude_archived: "true",
      };
      if (cursor) params.cursor = cursor;

      const res = await this.callApiGet("conversations.list", params);
      pages++;
      if (!res.ok) {
        // エラー時は今までに集めた分を返す（fail-soft）
        console.error("conversations.list error:", res);
        return {
          ok: false,
          error: res.error,
          channels: allChannels,
          pages,
          truncated: false,
        };
      }

      const channels = (res.channels as unknown[] | undefined) ?? [];
      allChannels.push(...channels);

      const meta = res.response_metadata as
        | { next_cursor?: string }
        | undefined;
      cursor = meta?.next_cursor ?? "";
      if (!cursor) break;
    }

    console.log(
      `getChannelList: fetched ${allChannels.length} channels in ${pages} pages`,
    );
    return { ok: true, channels: allChannels, pages, truncated: cursor !== "" };
  }

  async getChannelMembers(channel: string): Promise<SlackResponse> {
    return this.callApiGet("conversations.members", { channel });
  }

  async getChannelInfo(channel: string): Promise<SlackResponse> {
    return this.callApiGet("conversations.info", { channel });
  }

  /**
   * read-only Slack API (Claude 連携): チャンネルの直近メッセージを取得する。
   * conversations.history を 1:1 で写す薄いラッパー。
   * - channel: チャンネル ID (C.../G...)。名前解決は呼び出し側の責務。
   * - limit: 取得件数 (Slack 既定 100、ここでは呼び出し側が default/cap を制御)。
   * - oldest: この Unix ts (秒。小数可) より新しいメッセージのみ返す (任意)。
   *
   * 必要 scope: public は `channels:history`、private は `groups:history`
   * (どちらも oauth.ts の REQUIRED_SCOPES に付与済み)。bot が未参加の
   * チャンネルでは `not_in_channel` が返る (呼び出し側で fail-soft 表示)。
   *
   * 戻り値の messages[] は Slack 仕様で **新しい順** (newest first)。
   * 時系列 (oldest -> newest) に並べ替えるのは呼び出し側の責務。
   */
  async conversationsHistory(
    channel: string,
    opts?: { limit?: number; oldest?: string },
  ): Promise<SlackResponse> {
    const params: Record<string, string | number> = { channel };
    if (opts?.limit !== undefined) params.limit = opts.limit;
    if (opts?.oldest !== undefined && opts.oldest !== "") {
      params.oldest = opts.oldest;
    }
    return this.callApiGet("conversations.history", params);
  }

  /**
   * ADR-0008: 指定チャンネルに 1 ユーザーを招待する。
   * - public channel: `channels:manage` scope が必要
   * - private channel: `groups:write.invites` scope が必要
   * - 既に member の場合 `already_in_channel` で ok=false を返すので呼び出し側で許容判定
   */
  async inviteToChannel(
    channel: string,
    users: string,
  ): Promise<SlackResponse> {
    return this.callApi("conversations.invite", { channel, users });
  }

  /**
   * Sprint 24 (role_management): ワークスペース全員を pagination で取得する。
   * users:read scope が必要。
   *
   * - limit: 1 ページあたりの上限 (Slack 推奨 200, max 1000)
   * - max_pages: 安全弁。デフォルト 20 (= 最大 4000 人)
   *
   * deleted / bot / restricted の除外は呼び出し側の責務とする。
   */
  async listAllUsers(opts?: {
    limit?: number;
    maxPages?: number;
  }): Promise<{ ok: boolean; error?: string; members: SlackUser[] }> {
    const limit = opts?.limit ?? 200;
    const MAX_PAGES = opts?.maxPages ?? 20;
    const all: SlackUser[] = [];
    let cursor = "";
    let pages = 0;

    while (pages < MAX_PAGES) {
      const params: Record<string, string | number> = { limit };
      if (cursor) params.cursor = cursor;
      const res = await this.callApiGet("users.list", params);
      if (!res.ok) {
        return {
          ok: false,
          error: typeof res.error === "string" ? res.error : "unknown",
          members: all,
        };
      }
      const members = (res.members as SlackUser[] | undefined) ?? [];
      all.push(...members);
      const meta = res.response_metadata as
        | { next_cursor?: string }
        | undefined;
      cursor = meta?.next_cursor ?? "";
      pages++;
      if (!cursor) break;
    }
    return { ok: true, members: all };
  }

  /**
   * Sprint 24 (role_management): bulk invite。Slack API の users はカンマ区切り
   * 文字列で最大 1000 まで指定可能。空配列なら何もせず ok=true を返す。
   *
   * - public channel: `channels:manage` (or `channels:write.invites`) scope
   * - private channel: `groups:write` (or `groups:write.invites`) scope
   *
   * 既に member な user が含まれていると `already_in_channel` が返るため、
   * 呼び出し側でエラー耐性のある処理にすること。
   */
  async conversationsInviteBulk(
    channel: string,
    userIds: string[],
  ): Promise<SlackResponse> {
    if (userIds.length === 0) return { ok: true };
    return this.callApi("conversations.invite", {
      channel,
      users: userIds.join(","),
    });
  }

  /**
   * Sprint 24 (role_management): channel から user を kick する。
   * - public channel: `channels:manage` scope
   * - private channel: `groups:write` scope
   * bot 自身を kick しないよう、呼び出し側で auth.test の user_id を除外すること。
   */
  async conversationsKick(
    channel: string,
    userId: string,
  ): Promise<SlackResponse> {
    return this.callApi("conversations.kick", { channel, user: userId });
  }

  /**
   * ロール名⇄チャンネル名同期: チャンネルをリネームする。
   * Slack `conversations.rename` を 1:1 で写す薄いラッパー。
   * - public channel: `channels:manage` scope
   * - private channel: `groups:write` scope
   *   (どちらも既に付与済みなので追加インストール不要)
   *
   * name は Slack が命名規則で正規化する (小文字化・空白/ピリオド不可・最大80字。
   * 非ラテン文字=日本語は許容)。呼び出し側は事前に normalizeChannelName で
   * 正規化した値を渡し、レスポンスの channel.name で実際の確定名を確認すること。
   *
   * 認可制約: rename できるのは「作成者 / WS 管理者 / Channel Manager」のみ。
   * bot がこれに該当しない場合 `not_authorized` が返る (呼び出し側で fail-soft)。
   * 既に同名の場合 `name_taken` が返り得るので、呼び出し側は現状名と一致する
   * チャンネルを rename 対象から除外する (冪等)。
   */
  async renameChannel(channel: string, name: string): Promise<SlackResponse> {
    return this.callApi("conversations.rename", { channel, name });
  }

  /**
   * Sprint 24 (role_management): channel の現在の member 一覧を pagination で取得。
   * - public channel: `channels:read` scope
   * - private channel: `groups:read` scope
   */
  async listAllChannelMembers(
    channel: string,
    opts?: { limit?: number; maxPages?: number },
  ): Promise<{
    ok: boolean;
    error?: string;
    members: string[];
    pages: number;
    truncated: boolean;
  }> {
    const limit = opts?.limit ?? 200;
    const MAX_PAGES = Math.max(1, opts?.maxPages ?? 20);
    const all: string[] = [];
    let cursor = "";
    let pages = 0;

    // subrequest 予算対策: 1 cursor ページ = 1 subrequest。呼び出し側が
    // maxPages で「このチャンネルに費やしてよい subrequest 数」を制御でき、
    // 実消費数 (pages) と、cursor が残ったまま打ち切ったか (truncated) を返す。
    // truncated=true の members は不完全なので、diff 計算に使うと誤った
    // kick を生む。呼び出し側は truncated を error 相当に扱うこと。
    while (pages < MAX_PAGES) {
      const params: Record<string, string | number> = { channel, limit };
      if (cursor) params.cursor = cursor;
      const res = await this.callApiGet("conversations.members", params);
      pages++;
      if (!res.ok) {
        return {
          ok: false,
          error: typeof res.error === "string" ? res.error : "unknown",
          members: all,
          pages,
          truncated: false,
        };
      }
      const members = (res.members as string[] | undefined) ?? [];
      all.push(...members);
      const meta = res.response_metadata as
        | { next_cursor?: string }
        | undefined;
      cursor = meta?.next_cursor ?? "";
      if (!cursor) break;
    }
    return { ok: true, members: all, pages, truncated: cursor !== "" };
  }

  // ADR-0006: workspace bootstrap で team_id を取得するために使う
  async authTest(): Promise<
    SlackResponse & {
      team_id?: string;
      team?: string;
      user_id?: string;
    }
  > {
    return this.callApi("auth.test", {}) as Promise<
      SlackResponse & { team_id?: string; team?: string; user_id?: string }
    >;
  }

  async verifySignature(
    signature: string,
    timestamp: string,
    body: string,
  ): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - Number(timestamp)) > 300) {
      return false;
    }

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(this.signingSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const baseString = `v0:${timestamp}:${body}`;
    const signatureBytes = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(baseString),
    );

    const hex = Array.from(new Uint8Array(signatureBytes))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const expected = `v0=${hex}`;

    return expected === signature;
  }

  private async callApi(
    method: string,
    body: Record<string, unknown>,
  ): Promise<SlackResponse> {
    const response = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
    return response.json() as Promise<SlackResponse>;
  }

  private async callApiGet(
    method: string,
    params: Record<string, string | number>,
  ): Promise<SlackResponse> {
    const query = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)]),
    ).toString();
    const response = await fetch(`https://slack.com/api/${method}?${query}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });
    return response.json() as Promise<SlackResponse>;
  }
}
