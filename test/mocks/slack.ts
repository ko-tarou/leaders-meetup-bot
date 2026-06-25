/**
 * 006-0-1: Slack mock adapter (SlackPort 互換)。
 *
 * 実 Slack API を一切叩かず、呼び出しを記録し戻り値を差し替えられる
 * スパイ形式。`SlackClient` (src/services/slack-api.ts) のよく使う操作
 * (postMessage / updateMessage / postEphemeral / openView / listAllUsers /
 *  conversationsInviteBulk 等) と同じシグネチャを持つ。
 *
 * Phase 1 で adapter+DI 化する際、この I/F をそのまま Port 実装として
 * 注入できるよう薄く設計する。現状は vitest の `vi.mock("...slack-api")`
 * で `SlackClient` を本クラスに差し替える用途を想定。
 */
export type SlackResponse = { ok: boolean; error?: string; [k: string]: unknown };

export type SlackCall = { method: string; args: unknown[] };

const OK: SlackResponse = { ok: true };

/** postMessage に ts 付きレスポンスを設定するときに使う定数。notice_ts 保存テスト用。 */
export const MOCK_POST_TS = "mock-notice-ts-1.0";

export class MockSlackClient {
  /** 全呼び出しの記録 (method 名 + 引数)。アサーション用。 */
  public calls: SlackCall[] = [];

  /** method 名 → 固定レスポンス。未設定なら { ok: true }。 */
  private responses = new Map<string, SlackResponse>();

  /** method 名 → throw させたいエラー (fail-soft 検証用)。 */
  private failures = new Map<string, Error>();

  constructor(_token?: string, _signingSecret?: string) {}

  /** 指定 method の固定レスポンスを差し替える。 */
  setResponse(method: string, res: SlackResponse): this {
    this.responses.set(method, res);
    return this;
  }

  /** 指定 method を呼ぶと throw させる (例外伝播/fail-soft 検証用)。 */
  setFailure(method: string, err: Error): this {
    this.failures.set(method, err);
    return this;
  }

  /** 記録をクリアする。 */
  reset(): void {
    this.calls = [];
    this.responses.clear();
    this.failures.clear();
  }

  /** 指定 method の呼び出しのみ抽出する。 */
  callsOf(method: string): SlackCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  private record(method: string, args: unknown[]): SlackResponse {
    this.calls.push({ method, args });
    const fail = this.failures.get(method);
    if (fail) throw fail;
    return this.responses.get(method) ?? { ...OK };
  }

  async postMessage(
    channel: string,
    text: string,
    blocks?: unknown[],
    threadTs?: string,
  ): Promise<SlackResponse> {
    return this.record("postMessage", [channel, text, blocks, threadTs]);
  }

  async updateMessage(
    channel: string,
    ts: string,
    text: string,
    blocks?: unknown[],
  ): Promise<SlackResponse> {
    return this.record("updateMessage", [channel, ts, text, blocks]);
  }

  async deleteMessage(channel: string, ts: string): Promise<SlackResponse> {
    return this.record("deleteMessage", [channel, ts]);
  }

  async scheduleMessage(
    channel: string,
    postAt: number,
    text: string,
    blocks?: unknown[],
  ): Promise<SlackResponse> {
    return this.record("scheduleMessage", [channel, postAt, text, blocks]);
  }

  async addReaction(
    channel: string,
    timestamp: string,
    name: string,
  ): Promise<SlackResponse> {
    return this.record("addReaction", [channel, timestamp, name]);
  }

  async openView(triggerId: string, view: unknown): Promise<SlackResponse> {
    return this.record("openView", [triggerId, view]);
  }

  async updateView(viewId: string, view: unknown): Promise<SlackResponse> {
    return this.record("updateView", [viewId, view]);
  }

  async postEphemeral(
    channel: string,
    user: string,
    text: string,
    blocks?: unknown[],
  ): Promise<SlackResponse> {
    return this.record("postEphemeral", [channel, user, text, blocks]);
  }

  async getUserInfo(userId: string): Promise<SlackResponse> {
    return this.record("getUserInfo", [userId]);
  }

  async usersLookupByEmail(email: string): Promise<SlackResponse> {
    return this.record("usersLookupByEmail", [email]);
  }

  async getChannelList(): Promise<SlackResponse> {
    return this.record("getChannelList", []);
  }

  async listAllUsers(opts?: unknown): Promise<SlackResponse> {
    return this.record("listAllUsers", [opts]);
  }

  async conversationsInviteBulk(
    channel: string,
    userIds: string[],
  ): Promise<SlackResponse> {
    return this.record("conversationsInviteBulk", [channel, userIds]);
  }

  async conversationsKick(
    channel: string,
    user: string,
  ): Promise<SlackResponse> {
    return this.record("conversationsKick", [channel, user]);
  }

  async listAllChannelMembers(channel: string): Promise<SlackResponse> {
    return this.record("listAllChannelMembers", [channel]);
  }

  async getChannelInfo(channel: string): Promise<SlackResponse> {
    return this.record("getChannelInfo", [channel]);
  }

  async authTest(): Promise<SlackResponse> {
    return this.record("authTest", []);
  }

  /** reactions.get など SlackClient の private callApi を経由する呼び出しをモック。 */
  async callApi(
    method: string,
    body: Record<string, unknown>,
  ): Promise<SlackResponse> {
    return this.record(`callApi:${method}`, [body]);
  }
}

/** 新しい MockSlackClient を生成するファクトリ。 */
export function createMockSlackClient(): MockSlackClient {
  return new MockSlackClient();
}
