/**
 * Sprint 28: gmail-watcher の replyOnly フラグ characterization テスト。
 *
 * 観測面 (pickMatchingRule / isReplyEmail / normalizeRule):
 *   - replyOnly=true rule + subject "Re: 件名" → match する
 *   - replyOnly=true rule + In-Reply-To あり (Re: なし) → match する
 *   - replyOnly=true rule + 通常メール (Re: なし, In-Reply-To なし) → match しない
 *   - replyOnly=false / undefined rule → 返信判定はスキップされ keyword のみで判定
 *   - elseRule.replyOnly=true で catchall も「返信のみ」絞り込み可能
 *   - normalizeRule で replyOnly が boolean なら保持 / それ以外は undefined
 *
 * 既存挙動の互換性 (= replyOnly 未指定の rule が一切影響を受けないこと) を
 * 「番人」として固定する。後の hotfix で誤って AND 条件を壊さないようガード。
 */
import { describe, it, expect } from "vitest";
import {
  isReplyEmail,
  pickMatchingRule,
  normalizeWatcherConfig,
  type WatcherConfig,
  type WatcherRule,
} from "../../../src/services/gmail-watcher";

// === isReplyEmail (純関数) ===

describe("isReplyEmail", () => {
  it("subject が 'Re:' で始まれば true", () => {
    expect(isReplyEmail("Re: 件名", "")).toBe(true);
  });

  it("subject が 'RE:' (大文字) で始まれば true", () => {
    expect(isReplyEmail("RE: SUBJECT", "")).toBe(true);
  });

  it("subject が 're :' (空白あり) でも true", () => {
    expect(isReplyEmail("re : 件名", "")).toBe(true);
  });

  it("In-Reply-To ヘッダがあれば subject に Re: が無くても true", () => {
    expect(isReplyEmail("件名", "<abc@example.com>")).toBe(true);
  });

  it("subject に Re: 無し、In-Reply-To 無しなら false", () => {
    expect(isReplyEmail("ただの件名", "")).toBe(false);
  });

  it("subject に 'Re' を含むが 'Re:' で始まらないなら false (例: 'Are: x')", () => {
    expect(isReplyEmail("Are: foo", "")).toBe(false);
  });

  it("In-Reply-To が空白のみなら false", () => {
    expect(isReplyEmail("件名", "   ")).toBe(false);
  });
});

// === pickMatchingRule + replyOnly の AND 評価 ===

function makeRule(partial: Partial<WatcherRule>): WatcherRule {
  return {
    id: "r1",
    name: "ルール1",
    keywords: ["入部"],
    workspaceId: "ws1",
    channelId: "C1",
    channelName: "general",
    mentionUserIds: [],
    ...partial,
  };
}

function makeCfg(rules: WatcherRule[], elseRule?: WatcherRule): WatcherConfig {
  return { enabled: true, rules, elseRule };
}

describe("pickMatchingRule (replyOnly)", () => {
  it("replyOnly=true rule + subject 'Re: 入部希望' (keyword match + Re:) → match", () => {
    const cfg = makeCfg([makeRule({ replyOnly: true, keywords: ["入部"] })]);
    const got = pickMatchingRule(cfg, "Re: 入部希望", "本文", "");
    expect(got?.rule.id).toBe("r1");
  });

  it("replyOnly=true rule + In-Reply-To あり (subject に Re: なし) → match", () => {
    const cfg = makeCfg([makeRule({ replyOnly: true, keywords: ["入部"] })]);
    const got = pickMatchingRule(
      cfg,
      "入部希望",
      "本文",
      "<msg-id@example.com>",
    );
    expect(got?.rule.id).toBe("r1");
  });

  it("replyOnly=true rule + 通常メール (Re: なし, In-Reply-To なし) → match しない", () => {
    const cfg = makeCfg([makeRule({ replyOnly: true, keywords: ["入部"] })]);
    // keyword は match するが replyOnly 判定で弾かれる
    const got = pickMatchingRule(cfg, "入部希望", "本文", "");
    expect(got).toBeNull();
  });

  it("replyOnly=false rule → 既存挙動 (keyword 単独で判定)", () => {
    const cfg = makeCfg([makeRule({ replyOnly: false, keywords: ["入部"] })]);
    const got = pickMatchingRule(cfg, "入部希望", "本文", "");
    expect(got?.rule.id).toBe("r1");
  });

  it("replyOnly 未指定 rule → 既存挙動 (keyword 単独で判定、後方互換)", () => {
    const cfg = makeCfg([makeRule({ keywords: ["入部"] })]);
    const got = pickMatchingRule(cfg, "入部希望", "本文", "");
    expect(got?.rule.id).toBe("r1");
  });

  it("replyOnly=true rule + keyword が match しない → 当然 null", () => {
    const cfg = makeCfg([makeRule({ replyOnly: true, keywords: ["入部"] })]);
    const got = pickMatchingRule(cfg, "Re: 別件", "本文", "");
    expect(got).toBeNull();
  });

  it("複数 rule で先頭 replyOnly=true が弾かれた場合、次の rule が評価される", () => {
    const r1 = makeRule({
      id: "r1",
      replyOnly: true,
      keywords: ["入部"],
    });
    const r2 = makeRule({
      id: "r2",
      replyOnly: false,
      keywords: ["入部"],
    });
    const cfg = makeCfg([r1, r2]);
    // Re: なし → r1 は弾かれて r2 が選ばれる
    const got = pickMatchingRule(cfg, "入部希望", "本文", "");
    expect(got?.rule.id).toBe("r2");
  });

  it("elseRule.replyOnly=true で catchall を返信のみに絞れる", () => {
    const cfg = makeCfg(
      [],
      makeRule({ id: "else", name: "else", replyOnly: true, keywords: [] }),
    );
    // 通常メールは elseRule に到達するが replyOnly で弾かれる
    expect(pickMatchingRule(cfg, "件名", "本文", "")).toBeNull();
    // 返信なら elseRule で通知される
    const got = pickMatchingRule(cfg, "Re: 件名", "本文", "");
    expect(got?.rule.id).toBe("else");
  });

  it("inReplyTo 引数を省略しても従来通り動く (default '')", () => {
    const cfg = makeCfg([makeRule({ keywords: ["入部"] })]);
    const got = pickMatchingRule(cfg, "入部希望", "本文");
    expect(got?.rule.id).toBe("r1");
  });
});

// === normalizeRule の replyOnly 受け入れ ===

describe("normalizeWatcherConfig (replyOnly 経由)", () => {
  it("rule.replyOnly=true がそのまま保持される", () => {
    const cfg = normalizeWatcherConfig({
      enabled: true,
      rules: [
        {
          id: "r1",
          name: "x",
          keywords: ["a"],
          workspaceId: "ws1",
          channelId: "C1",
          mentionUserIds: [],
          replyOnly: true,
        },
      ],
    });
    expect(cfg?.rules[0].replyOnly).toBe(true);
  });

  it("rule.replyOnly=false もそのまま保持される", () => {
    const cfg = normalizeWatcherConfig({
      enabled: true,
      rules: [
        {
          id: "r1",
          name: "x",
          keywords: ["a"],
          workspaceId: "ws1",
          channelId: "C1",
          mentionUserIds: [],
          replyOnly: false,
        },
      ],
    });
    expect(cfg?.rules[0].replyOnly).toBe(false);
  });

  it("rule.replyOnly が未指定なら undefined", () => {
    const cfg = normalizeWatcherConfig({
      enabled: true,
      rules: [
        {
          id: "r1",
          name: "x",
          keywords: ["a"],
          workspaceId: "ws1",
          channelId: "C1",
          mentionUserIds: [],
        },
      ],
    });
    expect(cfg?.rules[0].replyOnly).toBeUndefined();
  });

  it("rule.replyOnly が非 boolean (例: 'yes') なら undefined に正規化", () => {
    const cfg = normalizeWatcherConfig({
      enabled: true,
      rules: [
        {
          id: "r1",
          name: "x",
          keywords: ["a"],
          workspaceId: "ws1",
          channelId: "C1",
          mentionUserIds: [],
          replyOnly: "yes",
        },
      ],
    });
    expect(cfg?.rules[0].replyOnly).toBeUndefined();
  });

  it("elseRule.replyOnly も保持される", () => {
    const cfg = normalizeWatcherConfig({
      enabled: true,
      rules: [],
      elseRule: {
        id: "e",
        name: "else",
        keywords: [],
        workspaceId: "ws1",
        channelId: "C1",
        mentionUserIds: [],
        replyOnly: true,
      },
    });
    expect(cfg?.elseRule?.replyOnly).toBe(true);
  });
});
