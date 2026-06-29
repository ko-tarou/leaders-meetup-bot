/**
 * PR レビュアー自動割当 純粋ドメインの unit。
 *   - detectDiscipline: ラベル > repoDisciplineMap > リポ名 > 既定 PM
 *   - selectReviewers: 主職能 -> 近接補完 -> 残り、重複/作者除外、最大 3 人
 */
import { describe, it, expect } from "vitest";
import {
  detectDiscipline,
  selectReviewers,
  disciplineSearchOrder,
  ADJACENCY,
} from "../../../src/domain/pr-review/reviewer-assign";

describe("detectDiscipline", () => {
  it("ラベルを最優先で判定する", () => {
    expect(
      detectDiscipline({ repo: "org/anything", labels: ["frontend", "bug"] }),
    ).toBe("フロントエンド");
    expect(detectDiscipline({ repo: "org/x", labels: ["android"] })).toBe(
      "Android",
    );
    expect(detectDiscipline({ repo: "org/x", labels: ["iOS"] })).toBe("iOS");
  });

  it("ラベルが無ければ repoDisciplineMap の明示設定を使う", () => {
    expect(
      detectDiscipline({
        repo: "org/secret-api",
        repoDisciplineMap: { "org/secret-api": "バックエンド" },
      }),
    ).toBe("バックエンド");
  });

  it("ラベル/マップが無ければリポ名のキーワードで推定する", () => {
    expect(detectDiscipline({ repo: "org/my-android-app" })).toBe("Android");
    expect(detectDiscipline({ repo: "org/web-frontend" })).toBe(
      "フロントエンド",
    );
    expect(detectDiscipline({ repo: "org/infra-terraform" })).toBe("インフラ");
    expect(detectDiscipline({ repo: "org/backend-api" })).toBe("バックエンド");
  });

  it("どれにも当たらなければ既定で PM", () => {
    expect(detectDiscipline({ repo: "org/random-thing" })).toBe("PM");
  });

  it("不正な repoDisciplineMap 値 (未知の職能) は無視してリポ名へ", () => {
    expect(
      detectDiscipline({
        repo: "org/backend-api",
        repoDisciplineMap: { "org/backend-api": "存在しない職能" },
      }),
    ).toBe("バックエンド");
  });
});

describe("disciplineSearchOrder", () => {
  it("主職能 -> 近接 -> 残り の順で全職能を網羅し重複しない", () => {
    const order = disciplineSearchOrder("フロントエンド");
    expect(order[0]).toBe("フロントエンド");
    expect(order.slice(1, 1 + ADJACENCY["フロントエンド"].length)).toEqual(
      ADJACENCY["フロントエンド"],
    );
    expect(new Set(order).size).toBe(order.length);
    expect(order).toHaveLength(6);
  });
});

describe("selectReviewers", () => {
  it("主職能だけで 3 人埋まれば近接補完しない", () => {
    const r = selectReviewers({
      primary: "バックエンド",
      membersByDiscipline: { バックエンド: ["U1", "U2", "U3", "U4"] },
    });
    expect(r.slackUserIds).toEqual(["U1", "U2", "U3"]);
    expect(r.usedFallback).toBe(false);
  });

  it("担当が 1 人だけなら近接分野から 3 人まで補完する", () => {
    const r = selectReviewers({
      primary: "フロントエンド",
      membersByDiscipline: {
        フロントエンド: ["U1"],
        バックエンド: ["U2", "U3", "U4"],
      },
    });
    expect(r.slackUserIds).toEqual(["U1", "U2", "U3"]);
    expect(r.usedFallback).toBe(true);
  });

  it("作者と重複は除外する", () => {
    const r = selectReviewers({
      primary: "バックエンド",
      membersByDiscipline: {
        バックエンド: ["AUTHOR", "U1", "U1", "U2"],
      },
      exclude: ["AUTHOR"],
    });
    expect(r.slackUserIds).toEqual(["U1", "U2"]);
  });

  it("Android は iOS から補完する (近接マップ)", () => {
    const r = selectReviewers({
      primary: "Android",
      membersByDiscipline: { Android: ["A1"], iOS: ["I1", "I2"] },
    });
    expect(r.slackUserIds).toEqual(["A1", "I1", "I2"]);
    expect(r.usedFallback).toBe(true);
  });

  it("候補ゼロなら空配列", () => {
    const r = selectReviewers({
      primary: "PM",
      membersByDiscipline: {},
    });
    expect(r.slackUserIds).toEqual([]);
  });

  it("limit を尊重する", () => {
    const r = selectReviewers({
      primary: "バックエンド",
      membersByDiscipline: { バックエンド: ["U1", "U2", "U3", "U4", "U5"] },
      limit: 2,
    });
    expect(r.slackUserIds).toEqual(["U1", "U2"]);
  });
});
