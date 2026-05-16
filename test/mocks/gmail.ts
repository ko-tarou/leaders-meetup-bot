/**
 * 006-0-1: Gmail mock adapter (GmailPort 互換)。
 *
 * 実際のメール送信を一切行わず、送信要求を記録するだけ。
 * `src/services/gmail-send.ts` の `sendGmailEmail` 相当の境界をモックする
 * ことを想定 (vitest の `vi.mock` で差し替え)。Phase 1 の GmailPort DI へ
 * そのまま載せ替えられる薄い I/F。
 */
export type SentEmail = {
  to: string;
  subject: string;
  body: string;
  [k: string]: unknown;
};

export class MockGmailClient {
  /** 送信要求の記録 (実送信はしない)。 */
  public sent: SentEmail[] = [];

  /** 次回送信で throw させたいエラー (fail-soft 検証用)。 */
  private nextError: Error | null = null;

  reset(): void {
    this.sent = [];
    this.nextError = null;
  }

  /** 次の send で throw させる。 */
  failNext(err: Error): this {
    this.nextError = err;
    return this;
  }

  /** メール送信をシミュレート (記録のみ)。 */
  async send(email: SentEmail): Promise<{ id: string }> {
    if (this.nextError) {
      const e = this.nextError;
      this.nextError = null;
      throw e;
    }
    this.sent.push(email);
    return { id: `mock-msg-${this.sent.length}` };
  }
}

export function createMockGmailClient(): MockGmailClient {
  return new MockGmailClient();
}
