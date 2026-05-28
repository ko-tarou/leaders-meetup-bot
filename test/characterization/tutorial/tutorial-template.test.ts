/**
 * 宗教イベント PR1: tutorial の文面組み立て + config parse 単体テスト。
 *
 * renderTutorialTemplate ({workspace} / {user} 置換) と parseTutorialConfig
 * (default fallback・正規化) の純粋ロジックを固定する。Slack 非接続。
 */
import { describe, it, expect } from "vitest";
import {
  renderTutorialTemplate,
  parseTutorialConfig,
  DEFAULT_TUTORIAL_TEMPLATE,
} from "../../../src/services/tutorial";

describe("renderTutorialTemplate", () => {
  it("{workspace} を workspace 名に置換する", () => {
    expect(
      renderTutorialTemplate("ようこそ {workspace} へ", {
        workspace: "Digital-Religion-AI",
        userId: "U1",
      }),
    ).toBe("ようこそ Digital-Religion-AI へ");
  });

  it("{user} を <@userId> メンションに置換する", () => {
    expect(
      renderTutorialTemplate("こんにちは {user} さん", {
        workspace: "WS",
        userId: "U123",
      }),
    ).toBe("こんにちは <@U123> さん");
  });

  it("{workspace} と {user} を両方置換する", () => {
    expect(
      renderTutorialTemplate("{workspace} へようこそ {user}", {
        workspace: "WS",
        userId: "U9",
      }),
    ).toBe("WS へようこそ <@U9>");
  });

  it("workspace が null のときは {workspace} を空文字に置換する", () => {
    expect(
      renderTutorialTemplate("[{workspace}]", { workspace: null, userId: "U1" }),
    ).toBe("[]");
  });

  it("複数の {workspace} / {user} を全て置換する", () => {
    expect(
      renderTutorialTemplate("{user} {user} {workspace}", {
        workspace: "W",
        userId: "U",
      }),
    ).toBe("<@U> <@U> W");
  });
});

describe("parseTutorialConfig", () => {
  it("空 / null config は default + 未設定 (id=null) に落ちる", () => {
    const c = parseTutorialConfig(null);
    expect(c.workspaceId).toBeNull();
    expect(c.triggerChannelId).toBeNull();
    expect(c.postChannelId).toBeNull();
    expect(c.deliveryMode).toBe("dm");
    expect(c.template).toBe(DEFAULT_TUTORIAL_TEMPLATE);
  });

  it("壊れた JSON は default 扱い", () => {
    const c = parseTutorialConfig("{bad json");
    expect(c.workspaceId).toBeNull();
    expect(c.template).toBe(DEFAULT_TUTORIAL_TEMPLATE);
  });

  it("空文字 template は DEFAULT_TUTORIAL_TEMPLATE に fallback (空投稿防止)", () => {
    expect(parseTutorialConfig('{"template":"   "}').template).toBe(
      DEFAULT_TUTORIAL_TEMPLATE,
    );
  });

  it("deliveryMode は 'channel' 以外を 'dm' に正規化する", () => {
    expect(parseTutorialConfig('{"deliveryMode":"email"}').deliveryMode).toBe(
      "dm",
    );
    expect(parseTutorialConfig('{"deliveryMode":"channel"}').deliveryMode).toBe(
      "channel",
    );
  });

  it("設定済みの値を保持する", () => {
    const c = parseTutorialConfig(
      JSON.stringify({
        workspaceId: "ws-1",
        triggerChannelId: "C-TRIG",
        deliveryMode: "channel",
        postChannelId: "C-POST",
        template: "hi {user}",
      }),
    );
    expect(c.workspaceId).toBe("ws-1");
    expect(c.triggerChannelId).toBe("C-TRIG");
    expect(c.deliveryMode).toBe("channel");
    expect(c.postChannelId).toBe("C-POST");
    expect(c.template).toBe("hi {user}");
  });
});
