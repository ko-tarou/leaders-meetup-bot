/**
 * 006-0-1: Gemini mock adapter (GeminiPort 互換)。
 *
 * 実 Gemini API を叩かず、固定文字列 (または設定した応答) を返す。
 * `src/services/gemini-chat.ts` の callGemini 相当の境界をモックする想定。
 */
export class MockGeminiClient {
  public prompts: string[] = [];
  private response = "mock gemini response";
  private nextError: Error | null = null;

  reset(): void {
    this.prompts = [];
    this.response = "mock gemini response";
    this.nextError = null;
  }

  /** 次回以降の固定応答を差し替える。 */
  setResponse(text: string): this {
    this.response = text;
    return this;
  }

  failNext(err: Error): this {
    this.nextError = err;
    return this;
  }

  async chat(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    if (this.nextError) {
      const e = this.nextError;
      this.nextError = null;
      throw e;
    }
    return this.response;
  }
}

export function createMockGeminiClient(): MockGeminiClient {
  return new MockGeminiClient();
}
