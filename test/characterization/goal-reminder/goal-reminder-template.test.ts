/**
 * 宗教イベント PR1: goal_reminder の文面組み立て単体テスト。
 *
 * renderGoalTemplate ({goal} 置換) と buildSlotText (slot 別テンプレ +
 * mention 接頭辞) の純粋ロジックを固定する。Slack には接続しない。
 */
import { describe, it, expect } from "vitest";
import {
  renderGoalTemplate,
  buildSlotText,
  parseGoalReminderConfig,
  type GoalReminderConfig,
} from "../../../src/services/goal-reminder";

function cfg(over: Partial<GoalReminderConfig> = {}): GoalReminderConfig {
  return {
    workspaceId: "ws-1",
    channelId: "C-GOAL",
    morningTime: "08:00",
    nightTime: "22:00",
    frequency: "daily",
    mention: "none",
    goalText: "次世代の宗教を作る",
    morningTemplate: "🔥 目標は『{goal}』です。",
    nightTemplate: "🌙 『{goal}』お疲れ様でした。",
    ...over,
  };
}

describe("renderGoalTemplate", () => {
  it("{goal} を goalText に置換する", () => {
    expect(renderGoalTemplate("目標は『{goal}』だ", "世界征服")).toBe(
      "目標は『世界征服』だ",
    );
  });

  it("複数の {goal} を全て置換する", () => {
    expect(renderGoalTemplate("{goal} と {goal}", "X")).toBe("X と X");
  });

  it("{goal} が無いテンプレはそのまま返す", () => {
    expect(renderGoalTemplate("ただの文章", "X")).toBe("ただの文章");
  });
});

describe("buildSlotText", () => {
  it("morning slot は morningTemplate を {goal} 置換で描画する", () => {
    expect(buildSlotText(cfg(), "morning")).toBe(
      "🔥 目標は『次世代の宗教を作る』です。",
    );
  });

  it("night slot は nightTemplate を {goal} 置換で描画する", () => {
    expect(buildSlotText(cfg(), "night")).toBe(
      "🌙 『次世代の宗教を作る』お疲れ様でした。",
    );
  });

  it("mention==='channel' のときだけ先頭に <!channel> を付ける", () => {
    expect(buildSlotText(cfg({ mention: "channel" }), "morning")).toBe(
      "<!channel> 🔥 目標は『次世代の宗教を作る』です。",
    );
  });

  it("mention==='none' では <!channel> を付けない", () => {
    expect(buildSlotText(cfg({ mention: "none" }), "morning")).not.toContain(
      "<!channel>",
    );
  });
});

describe("parseGoalReminderConfig", () => {
  it("空 / 不正 config は default + 未設定 (workspaceId/channelId=null) に落ちる", () => {
    const c = parseGoalReminderConfig(null);
    expect(c.workspaceId).toBeNull();
    expect(c.channelId).toBeNull();
    expect(c.morningTime).toBe("08:00");
    expect(c.nightTime).toBe("22:00");
    expect(c.frequency).toBe("daily");
    expect(c.mention).toBe("none");
    expect(c.goalText).toBe("次世代の宗教を作る");
  });

  it("壊れた JSON は default 扱い", () => {
    expect(parseGoalReminderConfig("{bad json").goalText).toBe(
      "次世代の宗教を作る",
    );
  });

  it("morningTime は 5 分単位に丸められる (08:17 → 08:15)", () => {
    expect(parseGoalReminderConfig('{"morningTime":"08:17"}').morningTime).toBe(
      "08:15",
    );
  });

  it("frequency / mention は許可値以外を default に正規化する", () => {
    const c = parseGoalReminderConfig(
      '{"frequency":"monthly","mention":"here"}',
    );
    expect(c.frequency).toBe("daily");
    expect(c.mention).toBe("none");
  });
});
