export type SlackResponse = {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
};

export class SlackClient {
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
  ): Promise<SlackResponse> {
    return this.callApi("chat.postMessage", { channel, text, blocks });
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

  async getChannelList(limit = 100): Promise<SlackResponse> {
    // users.conversations を使う（bot自身が参加中のチャンネルだけ返る）
    // conversations.list は is_member: false で返ることがあるため使わない
    return this.callApiGet("users.conversations", {
      limit,
      types: "public_channel,private_channel",
      exclude_archived: "true",
    });
  }

  async getChannelMembers(channel: string): Promise<SlackResponse> {
    return this.callApiGet("conversations.members", { channel });
  }

  async getChannelInfo(channel: string): Promise<SlackResponse> {
    return this.callApiGet("conversations.info", { channel });
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
