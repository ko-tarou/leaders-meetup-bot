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
    return this.callApi("users.info", { user: userId });
  }

  async getChannelList(limit = 100): Promise<SlackResponse> {
    return this.callApi("conversations.list", { limit });
  }

  async getChannelMembers(channel: string): Promise<SlackResponse> {
    return this.callApi("conversations.members", { channel });
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
}
