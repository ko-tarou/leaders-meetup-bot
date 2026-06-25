/**
 * Sprint 29: gmail-watcher の postBodyToThread (案A: 本文全文をスレ返信) の
 * characterization テスト。
 *
 * 観測面:
 *   - extractMessageBody: text/plain 優先 / text/html フォールバック /
 *     base64url デコード / payload なしは空文字
 *   - splitBodyForThread: 空 -> 「(本文なし)」/ 短文 -> 1 件 / 長文 -> 分割 +
 *     上限超過は末尾省略
 *   - accountNeedsBody: rule / elseRule のいずれかが postBodyToThread=true で true
 *   - normalizeRule: postBodyToThread が boolean なら保持 / それ以外は undefined
 *   - postBodyToThread(): thread_ts 付きで本文を投稿する / フラグ off の rule は
 *     スレ投稿しない (既存挙動の不変)
 */
import { describe, it, expect, vi } from "vitest";
import {
  extractMessageBody,
  splitBodyForThread,
  accountNeedsBody,
  postBodyToThread,
  normalizeWatcherConfig,
  type WatcherConfig,
  type WatcherRule,
} from "../../../src/services/gmail-watcher";

// base64url encode (padding 無し) ヘルパ。テストデータ生成用。
function b64url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

// === extractMessageBody ===

describe("extractMessageBody", () => {
  it("payload が undefined なら空文字 (format=metadata 相当)", () => {
    expect(extractMessageBody(undefined)).toBe("");
  });

  it("単一 text/plain part の本文を base64url デコードして返す", () => {
    const payload = {
      mimeType: "text/plain",
      body: { data: b64url("こんにちは\n本文です") },
    };
    expect(extractMessageBody(payload)).toBe("こんにちは\n本文です");
  });

  it("multipart/alternative で text/plain を優先する", () => {
    const payload = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/html", body: { data: b64url("<p>HTML側</p>") } },
        { mimeType: "text/plain", body: { data: b64url("プレーン側") } },
      ],
    };
    expect(extractMessageBody(payload)).toBe("プレーン側");
  });

  it("text/plain が無ければ text/html をテキスト化する", () => {
    const payload = {
      mimeType: "text/html",
      body: { data: b64url("<p>段落1</p><br>行2 &amp; 続き") },
    };
    const got = extractMessageBody(payload);
    expect(got).toContain("段落1");
    expect(got).toContain("行2 & 続き");
    expect(got).not.toContain("<p>");
  });

  it("ネストした multipart からも text/plain を見つける", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { data: b64url("深い本文") } },
          ],
        },
      ],
    };
    expect(extractMessageBody(payload)).toBe("深い本文");
  });

  it("本文 part が無ければ空文字", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [{ mimeType: "application/pdf", body: { data: b64url("bin") } }],
    };
    expect(extractMessageBody(payload)).toBe("");
  });
});

// === splitBodyForThread ===

describe("splitBodyForThread", () => {
  it("空文字なら『(本文なし)』1 件", () => {
    expect(splitBodyForThread("")).toEqual(["(本文なし)"]);
    expect(splitBodyForThread("   ")).toEqual(["(本文なし)"]);
  });

  it("短い本文は 1 チャンク", () => {
    expect(splitBodyForThread("短い本文")).toEqual(["短い本文"]);
  });

  it("3800 文字を超える本文は複数チャンクに分割する", () => {
    const body = "a".repeat(3800 * 2 + 100);
    const chunks = splitBodyForThread(body);
    expect(chunks.length).toBe(3);
    expect(chunks[0].length).toBe(3800);
  });

  it("上限チャンク数 (5) を超える本文は末尾を省略する", () => {
    const body = "b".repeat(3800 * 6);
    const chunks = splitBodyForThread(body);
    expect(chunks.length).toBe(5);
    expect(chunks[chunks.length - 1]).toContain("(以下省略)");
  });
});

// === accountNeedsBody ===

function makeRule(partial: Partial<WatcherRule>): WatcherRule {
  return {
    id: "r1",
    name: "ルール1",
    keywords: ["入部"],
    workspaceId: "ws1",
    channelId: "C1",
    mentionUserIds: [],
    ...partial,
  };
}

describe("accountNeedsBody", () => {
  it("どの rule も postBodyToThread off なら false", () => {
    const cfg: WatcherConfig = { enabled: true, rules: [makeRule({})] };
    expect(accountNeedsBody(cfg)).toBe(false);
  });

  it("rule のどれかが postBodyToThread=true なら true", () => {
    const cfg: WatcherConfig = {
      enabled: true,
      rules: [makeRule({}), makeRule({ id: "r2", postBodyToThread: true })],
    };
    expect(accountNeedsBody(cfg)).toBe(true);
  });

  it("elseRule が postBodyToThread=true でも true", () => {
    const cfg: WatcherConfig = {
      enabled: true,
      rules: [makeRule({})],
      elseRule: makeRule({ id: "else", postBodyToThread: true }),
    };
    expect(accountNeedsBody(cfg)).toBe(true);
  });
});

// === normalizeRule (postBodyToThread 正規化) ===

describe("normalizeWatcherConfig (postBodyToThread)", () => {
  it("postBodyToThread が boolean なら保持する", () => {
    const cfg = normalizeWatcherConfig({
      enabled: true,
      rules: [{ id: "r1", channelId: "C1", postBodyToThread: true }],
    });
    expect(cfg?.rules[0].postBodyToThread).toBe(true);
  });

  it("postBodyToThread キーが無い既存 rule は undefined (後方互換)", () => {
    const cfg = normalizeWatcherConfig({
      enabled: true,
      rules: [{ id: "r1", channelId: "C1" }],
    });
    expect(cfg?.rules[0].postBodyToThread).toBeUndefined();
  });

  it("postBodyToThread が非 boolean なら undefined に落とす", () => {
    const cfg = normalizeWatcherConfig({
      enabled: true,
      rules: [{ id: "r1", channelId: "C1", postBodyToThread: "yes" }],
    });
    expect(cfg?.rules[0].postBodyToThread).toBeUndefined();
  });
});

// === postBodyToThread() (スレ投稿) ===

describe("postBodyToThread()", () => {
  it("thread_ts 付きで本文を投稿する", async () => {
    const postMessage = vi.fn().mockResolvedValue({ ok: true });
    await postBodyToThread({ postMessage }, "C1", "1700000000.0001", "本文全文");
    expect(postMessage).toHaveBeenCalledTimes(1);
    // 引数: (channel, text, blocks, threadTs)
    expect(postMessage).toHaveBeenCalledWith(
      "C1",
      "本文全文",
      undefined,
      "1700000000.0001",
    );
  });

  it("本文が空でも『(本文なし)』を 1 件スレ投稿する", async () => {
    const postMessage = vi.fn().mockResolvedValue({ ok: true });
    await postBodyToThread({ postMessage }, "C1", "ts", "");
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][1]).toBe("(本文なし)");
  });

  it("postMessage が失敗したら以降のチャンクを止める (順序崩れ防止)", async () => {
    const postMessage = vi.fn().mockResolvedValue({ ok: false, error: "x" });
    const body = "c".repeat(3800 * 2);
    await postBodyToThread({ postMessage }, "C1", "ts", body);
    expect(postMessage).toHaveBeenCalledTimes(1);
  });
});
