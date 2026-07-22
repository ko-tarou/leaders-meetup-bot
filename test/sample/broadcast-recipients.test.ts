/**
 * participant_broadcast: pure domain (宛先 parse) の unit テスト。
 * 本番 export を無改変で import して挙動を固定する。
 */
import { describe, it, expect } from "vitest";
import {
  parseRecipients,
  parseRecipientLine,
  isLikelyEmail,
  readBroadcastConfig,
} from "../../src/domain/broadcast/recipients";

describe("isLikelyEmail", () => {
  it("正常なメールを通す", () => {
    expect(isLikelyEmail("foo@example.com")).toBe(true);
    expect(isLikelyEmail("a.b+c@sub.example.co.jp")).toBe(true);
  });
  it("不正なメールを弾く", () => {
    expect(isLikelyEmail("foo")).toBe(false);
    expect(isLikelyEmail("foo@bar")).toBe(false); // ドメインにドット無し
    expect(isLikelyEmail("foo @example.com")).toBe(false); // 空白
    expect(isLikelyEmail("@example.com")).toBe(false);
    expect(isLikelyEmail("a@@b.com")).toBe(false);
  });
});

describe("parseRecipientLine", () => {
  it("素のメール", () => {
    expect(parseRecipientLine("foo@example.com")).toEqual({
      email: "foo@example.com",
      name: "",
    });
  });
  it("カンマ区切りで名前つき", () => {
    expect(parseRecipientLine("foo@example.com,山田太郎")).toEqual({
      email: "foo@example.com",
      name: "山田太郎",
    });
  });
  it("Name <email> 形式", () => {
    expect(parseRecipientLine("山田太郎 <Foo@Example.com>")).toEqual({
      email: "foo@example.com",
      name: "山田太郎",
    });
  });
  it("不正行は null", () => {
    expect(parseRecipientLine("not-an-email")).toBeNull();
    expect(parseRecipientLine("")).toBeNull();
  });
});

describe("parseRecipients", () => {
  it("複数行を parse し重複除去する", () => {
    const r = parseRecipients(
      [
        "a@example.com,Aさん",
        "b@example.com",
        "A@example.com", // 大文字違いの重複
        "こわれた行",
        "",
      ].join("\n"),
    );
    expect(r.recipients).toEqual([
      { email: "a@example.com", name: "Aさん" },
      { email: "b@example.com", name: "" },
    ]);
    expect(r.duplicateCount).toBe(1);
    expect(r.invalidLines).toEqual(["こわれた行"]);
  });
  it("空入力は空の結果", () => {
    expect(parseRecipients("")).toEqual({
      recipients: [],
      invalidLines: [],
      duplicateCount: 0,
    });
    expect(parseRecipients(null)).toEqual({
      recipients: [],
      invalidLines: [],
      duplicateCount: 0,
    });
  });
});

describe("readBroadcastConfig", () => {
  it("不正 JSON は空オブジェクト", () => {
    expect(readBroadcastConfig("{bad")).toEqual({});
    expect(readBroadcastConfig(null)).toEqual({});
  });
  it("フィールドを取り出す", () => {
    expect(
      readBroadcastConfig(
        JSON.stringify({
          gmailAccountId: "g1",
          recipientsText: "a@x.com",
          subject: "件名",
          body: "本文",
          extra: "無視",
        }),
      ),
    ).toEqual({
      gmailAccountId: "g1",
      recipientsText: "a@x.com",
      subject: "件名",
      body: "本文",
    });
  });
});
