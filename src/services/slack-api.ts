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
