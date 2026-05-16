/**
 * 006-0-1 サンプル (a): 既存純粋関数の unit テスト。
 *
 * 本番コード (`src/services/application-notification.ts`) を **変更せず**
 * そのまま import して検証する。テスト基盤が「本番 export を import して
 * 純粋関数を呼べる」ことの証明。
 */
import { describe, it, expect } from "vitest";
import {
  renderTemplate,
  readNotificationsConfig,
} from "../../src/services/application-notification";

describe("renderTemplate (characterization sample)", () => {
  it("既知 placeholder を vars で置換する", () => {
    const out = renderTemplate("hi {name} <{email}>", {
      name: "太郎",
      email: "t@example.com",
    });
    expect(out).toBe("hi 太郎 <t@example.com>");
  });

  it("未定義 placeholder はそのまま残す (現状仕様を固定)", () => {
    const out = renderTemplate("{known} {unknown}", { known: "X" });
    expect(out).toBe("X {unknown}");
  });

  it("vars が空でも壊れない", () => {
    expect(renderTemplate("plain text", {})).toBe("plain text");
  });
});

describe("readNotificationsConfig (characterization sample)", () => {
  it("不正 JSON は undefined を返す", () => {
    expect(readNotificationsConfig("{not json")).toBeUndefined();
  });

  it("null/空は undefined", () => {
    expect(readNotificationsConfig(null)).toBeUndefined();
    expect(readNotificationsConfig("")).toBeUndefined();
  });

  it("notifications を取り出す", () => {
    const cfg = readNotificationsConfig(
      JSON.stringify({ notifications: { enabled: true, channelId: "C1" } }),
    );
    expect(cfg).toEqual({ enabled: true, channelId: "C1" });
  });
});
