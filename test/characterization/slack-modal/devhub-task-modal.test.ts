/**
 * Phase3-1 段階1 characterization: devhub-task-modal の Slack モーダル view builder。
 *
 * DevHub Ops 大規模リファクタの回帰網。`src/services/devhub-task-modal.ts` の
 * モーダル view 構築関数の **現状の戻り値 view JSON 構造を "あるがまま"
 * スナップショット的に固定** する (理想仕様ではなく今の出力を assert)。
 * 本番コードは 1 行も変更しない (import のみ)。
 *
 * Phase3-1 段階2（Slack block builder 共通化）の前に green であることが必須。
 * 共通化で block JSON が無自覚に変質しても、この番人が検知する。
 *
 * 既存の characterization と非重複:
 *  - 0-5 (sticky-pr-review-board): PR レビュー *board* の blocks
 *  - 0-7 (slack-blocks-task-board): task *board* の blocks + 共有 slack-blocks builder
 *  - ここ: /devhub task add・sticky task add・PR レビュー add/edit *モーダル view*
 *
 * 固定対象（ユーザー観測面 + ハンドラ契約面）:
 *  - buildTaskAddModalView: type/callback_id/private_metadata/title/submit/close、
 *      8 input block の block_id・action_id・element type・optional・max_length・
 *      multiline・priority の initial_option/options
 *  - buildStickyTaskAddModal: buildTaskAddModalView と blocks 完全一致で
 *      callback_id だけ "sticky_task_add_submit" に差し替わる
 *  - buildPRReviewAddModal: callback_id・private_metadata 形・4 input block・
 *      reviewer の max_selected_items=PR_REVIEW_MAX_REVIEWERS
 *  - buildPRReviewEditModal: prefill (initial_value/initial_users)・条件付き
 *      initial_value (url/description 無し時はキー自体が無い)・reviewer 切り詰め・
 *      divider + actions（強制完了 / 再レビュー依頼ボタンの action_id・value・
 *      confirm dialog）
 *  - PR_REVIEW_MAX_REVIEWERS 定数 = 5
 *  - jstDateTimeToUtcIso: JST 壁時計 → UTC ISO 変換（時刻未指定は 09:00 JST）
 */
import { describe, it, expect } from "vitest";
import {
  buildTaskAddModalView,
  buildStickyTaskAddModal,
  buildPRReviewAddModal,
  buildPRReviewEditModal,
  PR_REVIEW_MAX_REVIEWERS,
  jstDateTimeToUtcIso,
  type TaskAddModalMetadata,
} from "../../../src/services/devhub-task-modal";

const META: TaskAddModalMetadata = {
  eventId: "ev-1",
  channelId: "C-1",
  createdBySlackId: "U-CREATOR",
};

// 型を緩く受けるためのヘルパ型（characterization は構造を見るだけ）
type AnyBlock = Record<string, unknown> & {
  type: string;
  block_id?: string;
  optional?: boolean;
  element?: Record<string, unknown> & { type: string; action_id?: string };
  elements?: Array<Record<string, unknown> & { type: string }>;
};
type AnyView = {
  type: string;
  callback_id: string;
  private_metadata: string;
  title: { type: string; text: string };
  submit: { type: string; text: string };
  close: { type: string; text: string };
  blocks: AnyBlock[];
};

// ---------------------------------------------------------------------------
// PR_REVIEW_MAX_REVIEWERS (定数)
// ---------------------------------------------------------------------------
describe("PR_REVIEW_MAX_REVIEWERS (現状固定)", () => {
  it("レビュアー上限は 5", () => {
    expect(PR_REVIEW_MAX_REVIEWERS).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// buildTaskAddModalView (pure)
// ---------------------------------------------------------------------------
describe("buildTaskAddModalView (現状固定)", () => {
  it("modal 枠: type/callback_id/private_metadata/title/submit/close", () => {
    const v = buildTaskAddModalView(META) as AnyView;
    expect(v.type).toBe("modal");
    expect(v.callback_id).toBe("devhub_task_add_submit");
    expect(v.private_metadata).toBe(JSON.stringify(META));
    expect(v.title).toEqual({ type: "plain_text", text: "タスクを作成" });
    expect(v.submit).toEqual({ type: "plain_text", text: "作成" });
    expect(v.close).toEqual({ type: "plain_text", text: "キャンセル" });
  });

  it("private_metadata は渡した meta を JSON.stringify した文字列そのもの", () => {
    const meta: TaskAddModalMetadata = {
      eventId: "E\"x",
      channelId: "C-Z",
      createdBySlackId: "U-Q",
    };
    const v = buildTaskAddModalView(meta) as AnyView;
    expect(JSON.parse(v.private_metadata)).toEqual(meta);
  });

  it("blocks は 8 要素 (全て input)、block_id 順序固定", () => {
    const v = buildTaskAddModalView(META) as AnyView;
    expect(v.blocks).toHaveLength(8);
    expect(v.blocks.map((b) => b.block_id)).toEqual([
      "title_block",
      "desc_block",
      "assignees_block",
      "start_date_block",
      "start_time_block",
      "due_date_block",
      "due_time_block",
      "priority_block",
    ]);
    // 全ブロック type=input
    expect(v.blocks.every((b) => b.type === "input")).toBe(true);
  });

  it("title_block: 必須 (optional 無)・plain_text_input・max_length 200", () => {
    const v = buildTaskAddModalView(META) as AnyView;
    const b = v.blocks[0];
    expect(b.block_id).toBe("title_block");
    expect(b.optional).toBeUndefined();
    expect(b.label).toEqual({ type: "plain_text", text: "タスク名" });
    expect(b.element).toEqual({
      type: "plain_text_input",
      action_id: "title_input",
      max_length: 200,
    });
  });

  it("desc_block: optional・multiline・max_length 2000", () => {
    const v = buildTaskAddModalView(META) as AnyView;
    const b = v.blocks[1];
    expect(b.block_id).toBe("desc_block");
    expect(b.optional).toBe(true);
    expect(b.element).toEqual({
      type: "plain_text_input",
      action_id: "desc_input",
      multiline: true,
      max_length: 2000,
    });
  });

  it("assignees_block: optional・multi_users_select・placeholder", () => {
    const v = buildTaskAddModalView(META) as AnyView;
    const b = v.blocks[2];
    expect(b.block_id).toBe("assignees_block");
    expect(b.optional).toBe(true);
    expect(b.element).toEqual({
      type: "multi_users_select",
      action_id: "assignees_input",
      placeholder: { type: "plain_text", text: "担当者を選択" },
    });
  });

  it("start_date_block / start_time_block: optional・datepicker / timepicker", () => {
    const v = buildTaskAddModalView(META) as AnyView;
    const sd = v.blocks[3];
    expect(sd.block_id).toBe("start_date_block");
    expect(sd.optional).toBe(true);
    expect(sd.label).toEqual({ type: "plain_text", text: "開始日（任意）" });
    expect(sd.element).toEqual({
      type: "datepicker",
      action_id: "start_date_input",
    });
    const st = v.blocks[4];
    expect(st.block_id).toBe("start_time_block");
    expect(st.optional).toBe(true);
    expect(st.label).toEqual({
      type: "plain_text",
      text: "開始時刻（JST、任意。日付指定時のみ有効）",
    });
    expect(st.element).toEqual({
      type: "timepicker",
      action_id: "start_time_input",
    });
  });

  it("due_date_block / due_time_block: optional・datepicker / timepicker", () => {
    const v = buildTaskAddModalView(META) as AnyView;
    const dd = v.blocks[5];
    expect(dd.block_id).toBe("due_date_block");
    expect(dd.optional).toBe(true);
    expect(dd.label).toEqual({ type: "plain_text", text: "期限日（任意）" });
    expect(dd.element).toEqual({
      type: "datepicker",
      action_id: "due_date_input",
    });
    const dt = v.blocks[6];
    expect(dt.block_id).toBe("due_time_block");
    expect(dt.optional).toBe(true);
    expect(dt.label).toEqual({
      type: "plain_text",
      text: "期限時刻（JST、任意。日付指定時のみ有効）",
    });
    expect(dt.element).toEqual({
      type: "timepicker",
      action_id: "due_time_input",
    });
  });

  it("priority_block: 必須・static_select・initial_option=中(mid)・3 options", () => {
    const v = buildTaskAddModalView(META) as AnyView;
    const b = v.blocks[7];
    expect(b.block_id).toBe("priority_block");
    expect(b.optional).toBeUndefined();
    expect(b.label).toEqual({ type: "plain_text", text: "優先度" });
    expect(b.element).toEqual({
      type: "static_select",
      action_id: "priority_input",
      initial_option: {
        text: { type: "plain_text", text: "中" },
        value: "mid",
      },
      options: [
        { text: { type: "plain_text", text: "低" }, value: "low" },
        { text: { type: "plain_text", text: "中" }, value: "mid" },
        { text: { type: "plain_text", text: "高" }, value: "high" },
      ],
    });
  });

  it("view 全体スナップショット（構造を丸ごと固定）", () => {
    expect(buildTaskAddModalView(META)).toMatchInlineSnapshot(`
      {
        "blocks": [
          {
            "block_id": "title_block",
            "element": {
              "action_id": "title_input",
              "max_length": 200,
              "type": "plain_text_input",
            },
            "label": {
              "text": "タスク名",
              "type": "plain_text",
            },
            "type": "input",
          },
          {
            "block_id": "desc_block",
            "element": {
              "action_id": "desc_input",
              "max_length": 2000,
              "multiline": true,
              "type": "plain_text_input",
            },
            "label": {
              "text": "詳細",
              "type": "plain_text",
            },
            "optional": true,
            "type": "input",
          },
          {
            "block_id": "assignees_block",
            "element": {
              "action_id": "assignees_input",
              "placeholder": {
                "text": "担当者を選択",
                "type": "plain_text",
              },
              "type": "multi_users_select",
            },
            "label": {
              "text": "担当者",
              "type": "plain_text",
            },
            "optional": true,
            "type": "input",
          },
          {
            "block_id": "start_date_block",
            "element": {
              "action_id": "start_date_input",
              "type": "datepicker",
            },
            "label": {
              "text": "開始日（任意）",
              "type": "plain_text",
            },
            "optional": true,
            "type": "input",
          },
          {
            "block_id": "start_time_block",
            "element": {
              "action_id": "start_time_input",
              "type": "timepicker",
            },
            "label": {
              "text": "開始時刻（JST、任意。日付指定時のみ有効）",
              "type": "plain_text",
            },
            "optional": true,
            "type": "input",
          },
          {
            "block_id": "due_date_block",
            "element": {
              "action_id": "due_date_input",
              "type": "datepicker",
            },
            "label": {
              "text": "期限日（任意）",
              "type": "plain_text",
            },
            "optional": true,
            "type": "input",
          },
          {
            "block_id": "due_time_block",
            "element": {
              "action_id": "due_time_input",
              "type": "timepicker",
            },
            "label": {
              "text": "期限時刻（JST、任意。日付指定時のみ有効）",
              "type": "plain_text",
            },
            "optional": true,
            "type": "input",
          },
          {
            "block_id": "priority_block",
            "element": {
              "action_id": "priority_input",
              "initial_option": {
                "text": {
                  "text": "中",
                  "type": "plain_text",
                },
                "value": "mid",
              },
              "options": [
                {
                  "text": {
                    "text": "低",
                    "type": "plain_text",
                  },
                  "value": "low",
                },
                {
                  "text": {
                    "text": "中",
                    "type": "plain_text",
                  },
                  "value": "mid",
                },
                {
                  "text": {
                    "text": "高",
                    "type": "plain_text",
                  },
                  "value": "high",
                },
              ],
              "type": "static_select",
            },
            "label": {
              "text": "優先度",
              "type": "plain_text",
            },
            "type": "input",
          },
        ],
        "callback_id": "devhub_task_add_submit",
        "close": {
          "text": "キャンセル",
          "type": "plain_text",
        },
        "private_metadata": "{"eventId":"ev-1","channelId":"C-1","createdBySlackId":"U-CREATOR"}",
        "submit": {
          "text": "作成",
          "type": "plain_text",
        },
        "title": {
          "text": "タスクを作成",
          "type": "plain_text",
        },
        "type": "modal",
      }
    `);
  });
});

// ---------------------------------------------------------------------------
// buildStickyTaskAddModal (pure)
// ---------------------------------------------------------------------------
describe("buildStickyTaskAddModal (現状固定)", () => {
  it("callback_id だけ sticky_task_add_submit、それ以外は task add と同一", () => {
    const base = buildTaskAddModalView(META) as AnyView;
    const sticky = buildStickyTaskAddModal(META) as AnyView;
    expect(sticky.callback_id).toBe("sticky_task_add_submit");
    // callback_id 以外は完全一致
    expect({ ...sticky, callback_id: base.callback_id }).toEqual(base);
  });

  it("blocks は buildTaskAddModalView と完全一致 (deep equal)", () => {
    const base = buildTaskAddModalView(META) as AnyView;
    const sticky = buildStickyTaskAddModal(META) as AnyView;
    expect(sticky.blocks).toEqual(base.blocks);
  });

  it("private_metadata は渡した meta をそのまま JSON 化", () => {
    const sticky = buildStickyTaskAddModal(META) as AnyView;
    expect(JSON.parse(sticky.private_metadata)).toEqual(META);
  });
});

// ---------------------------------------------------------------------------
// buildPRReviewAddModal (pure)
// ---------------------------------------------------------------------------
describe("buildPRReviewAddModal (現状固定)", () => {
  it("modal 枠: callback_id=sticky_pr_review_add_submit・title/submit/close", () => {
    const v = buildPRReviewAddModal("ev-9", "U-RQ", "C-9") as AnyView;
    expect(v.type).toBe("modal");
    expect(v.callback_id).toBe("sticky_pr_review_add_submit");
    expect(v.title).toEqual({ type: "plain_text", text: "レビュー依頼を作成" });
    expect(v.submit).toEqual({ type: "plain_text", text: "作成" });
    expect(v.close).toEqual({ type: "plain_text", text: "キャンセル" });
  });

  it("private_metadata = { eventId, requesterSlackId, channelId } JSON", () => {
    const v = buildPRReviewAddModal("ev-9", "U-RQ", "C-9") as AnyView;
    expect(JSON.parse(v.private_metadata)).toEqual({
      eventId: "ev-9",
      requesterSlackId: "U-RQ",
      channelId: "C-9",
    });
  });

  it("blocks は 4 要素 (title/url/desc/reviewer)、block_id 順序固定", () => {
    const v = buildPRReviewAddModal("ev-9", "U-RQ", "C-9") as AnyView;
    expect(v.blocks).toHaveLength(4);
    expect(v.blocks.map((b) => b.block_id)).toEqual([
      "title_block",
      "url_block",
      "desc_block",
      "reviewer_block",
    ]);
    expect(v.blocks.every((b) => b.type === "input")).toBe(true);
  });

  it("title_block 必須・url/desc optional・desc multiline max_length 2000", () => {
    const v = buildPRReviewAddModal("ev-9", "U-RQ", "C-9") as AnyView;
    expect(v.blocks[0].optional).toBeUndefined();
    expect(v.blocks[0].element).toEqual({
      type: "plain_text_input",
      action_id: "title_input",
      max_length: 200,
    });
    expect(v.blocks[1].optional).toBe(true);
    expect(v.blocks[1].element).toEqual({
      type: "plain_text_input",
      action_id: "url_input",
    });
    expect(v.blocks[2].optional).toBe(true);
    expect(v.blocks[2].element).toEqual({
      type: "plain_text_input",
      action_id: "desc_input",
      multiline: true,
      max_length: 2000,
    });
  });

  it("reviewer_block: multi_users_select・max_selected_items=5・placeholder", () => {
    const v = buildPRReviewAddModal("ev-9", "U-RQ", "C-9") as AnyView;
    const b = v.blocks[3];
    expect(b.block_id).toBe("reviewer_block");
    expect(b.optional).toBe(true);
    expect(b.element).toEqual({
      type: "multi_users_select",
      action_id: "reviewer_input",
      max_selected_items: PR_REVIEW_MAX_REVIEWERS,
      placeholder: { type: "plain_text", text: "レビュアーを選択" },
    });
  });

  it("view 全体スナップショット", () => {
    expect(
      buildPRReviewAddModal("ev-9", "U-RQ", "C-9"),
    ).toMatchInlineSnapshot(`
      {
        "blocks": [
          {
            "block_id": "title_block",
            "element": {
              "action_id": "title_input",
              "max_length": 200,
              "type": "plain_text_input",
            },
            "label": {
              "text": "タイトル",
              "type": "plain_text",
            },
            "type": "input",
          },
          {
            "block_id": "url_block",
            "element": {
              "action_id": "url_input",
              "type": "plain_text_input",
            },
            "label": {
              "text": "URL（PR/Issue リンク）",
              "type": "plain_text",
            },
            "optional": true,
            "type": "input",
          },
          {
            "block_id": "desc_block",
            "element": {
              "action_id": "desc_input",
              "max_length": 2000,
              "multiline": true,
              "type": "plain_text_input",
            },
            "label": {
              "text": "説明",
              "type": "plain_text",
            },
            "optional": true,
            "type": "input",
          },
          {
            "block_id": "reviewer_block",
            "element": {
              "action_id": "reviewer_input",
              "max_selected_items": 5,
              "placeholder": {
                "text": "レビュアーを選択",
                "type": "plain_text",
              },
              "type": "multi_users_select",
            },
            "label": {
              "text": "レビュアー（任意・最大5人）",
              "type": "plain_text",
            },
            "optional": true,
            "type": "input",
          },
        ],
        "callback_id": "sticky_pr_review_add_submit",
        "close": {
          "text": "キャンセル",
          "type": "plain_text",
        },
        "private_metadata": "{"eventId":"ev-9","requesterSlackId":"U-RQ","channelId":"C-9"}",
        "submit": {
          "text": "作成",
          "type": "plain_text",
        },
        "title": {
          "text": "レビュー依頼を作成",
          "type": "plain_text",
        },
        "type": "modal",
      }
    `);
  });
});

// ---------------------------------------------------------------------------
// buildPRReviewEditModal (pure)
// ---------------------------------------------------------------------------
const EDIT_BASE = {
  reviewId: "rev-1",
  eventId: "ev-1",
  channelId: "C-1",
  title: "PR タイトル",
};

describe("buildPRReviewEditModal (現状固定)", () => {
  it("modal 枠: callback_id=sticky_pr_review_edit_submit・保存/閉じる", () => {
    const v = buildPRReviewEditModal({
      ...EDIT_BASE,
      reviewerSlackIds: [],
    }) as AnyView;
    expect(v.type).toBe("modal");
    expect(v.callback_id).toBe("sticky_pr_review_edit_submit");
    expect(v.title).toEqual({ type: "plain_text", text: "レビュー依頼を編集" });
    expect(v.submit).toEqual({ type: "plain_text", text: "保存" });
    expect(v.close).toEqual({ type: "plain_text", text: "閉じる" });
  });

  it("private_metadata = { reviewId, eventId, channelId } のみ", () => {
    const v = buildPRReviewEditModal({
      ...EDIT_BASE,
      reviewerSlackIds: [],
    }) as AnyView;
    expect(JSON.parse(v.private_metadata)).toEqual({
      reviewId: "rev-1",
      eventId: "ev-1",
      channelId: "C-1",
    });
  });

  it("title は initial_value にプリフィルされる", () => {
    const v = buildPRReviewEditModal({
      ...EDIT_BASE,
      reviewerSlackIds: [],
    }) as AnyView;
    expect(v.blocks[0].element).toEqual({
      type: "plain_text_input",
      action_id: "title_input",
      max_length: 200,
      initial_value: "PR タイトル",
    });
  });

  it("description / url 無し → element に initial_value キー自体が無い", () => {
    const v = buildPRReviewEditModal({
      ...EDIT_BASE,
      reviewerSlackIds: [],
    }) as AnyView;
    expect(v.blocks[1].element).toEqual({
      type: "plain_text_input",
      action_id: "desc_input",
      multiline: true,
      max_length: 2000,
    });
    expect(v.blocks[1].element).not.toHaveProperty("initial_value");
    expect(v.blocks[2].element).toEqual({
      type: "plain_text_input",
      action_id: "url_input",
    });
    expect(v.blocks[2].element).not.toHaveProperty("initial_value");
  });

  it("description / url 有り → initial_value にプリフィル", () => {
    const v = buildPRReviewEditModal({
      ...EDIT_BASE,
      description: "説明文",
      url: "https://example.com/pr/1",
      reviewerSlackIds: [],
    }) as AnyView;
    expect(v.blocks[1].element).toEqual({
      type: "plain_text_input",
      action_id: "desc_input",
      multiline: true,
      max_length: 2000,
      initial_value: "説明文",
    });
    expect(v.blocks[2].element).toEqual({
      type: "plain_text_input",
      action_id: "url_input",
      initial_value: "https://example.com/pr/1",
    });
  });

  it("description / url が null → initial_value 無し (空文字も falsy 扱い)", () => {
    const v = buildPRReviewEditModal({
      ...EDIT_BASE,
      description: null,
      url: null,
      reviewerSlackIds: [],
    }) as AnyView;
    expect(v.blocks[1].element).not.toHaveProperty("initial_value");
    expect(v.blocks[2].element).not.toHaveProperty("initial_value");
  });

  it("reviewer 0 件 → element に initial_users キー自体が無い", () => {
    const v = buildPRReviewEditModal({
      ...EDIT_BASE,
      reviewerSlackIds: [],
    }) as AnyView;
    expect(v.blocks[3].element).toEqual({
      type: "multi_users_select",
      action_id: "reviewer_input",
      max_selected_items: PR_REVIEW_MAX_REVIEWERS,
      placeholder: { type: "plain_text", text: "レビュアーを選択" },
    });
    expect(v.blocks[3].element).not.toHaveProperty("initial_users");
  });

  it("reviewer 有り → initial_users にプリフィル", () => {
    const v = buildPRReviewEditModal({
      ...EDIT_BASE,
      reviewerSlackIds: ["U-1", "U-2"],
    }) as AnyView;
    expect(v.blocks[3].element).toEqual({
      type: "multi_users_select",
      action_id: "reviewer_input",
      max_selected_items: PR_REVIEW_MAX_REVIEWERS,
      placeholder: { type: "plain_text", text: "レビュアーを選択" },
      initial_users: ["U-1", "U-2"],
    });
  });

  it("reviewer は PR_REVIEW_MAX_REVIEWERS で切り詰める (6→5)", () => {
    const v = buildPRReviewEditModal({
      ...EDIT_BASE,
      reviewerSlackIds: ["U-1", "U-2", "U-3", "U-4", "U-5", "U-6"],
    }) as AnyView;
    expect(
      (v.blocks[3].element as { initial_users: string[] }).initial_users,
    ).toEqual(["U-1", "U-2", "U-3", "U-4", "U-5"]);
  });

  it("blocks 構成: 4 input + divider + actions の 6 要素", () => {
    const v = buildPRReviewEditModal({
      ...EDIT_BASE,
      reviewerSlackIds: [],
    }) as AnyView;
    expect(v.blocks).toHaveLength(6);
    expect(v.blocks.map((b) => b.type)).toEqual([
      "input",
      "input",
      "input",
      "input",
      "divider",
      "actions",
    ]);
    expect(v.blocks.slice(0, 4).map((b) => b.block_id)).toEqual([
      "title_block",
      "desc_block",
      "url_block",
      "reviewer_block",
    ]);
  });

  it("actions: 強制完了 / 再レビュー依頼 ボタン (action_id・value・confirm)", () => {
    const v = buildPRReviewEditModal({
      ...EDIT_BASE,
      reviewerSlackIds: [],
    }) as AnyView;
    const actions = v.blocks[5];
    expect(actions.type).toBe("actions");
    const els = actions.elements as Array<{
      type: string;
      action_id: string;
      text: { type: string; text: string };
      value: string;
      style?: string;
      confirm: Record<string, unknown>;
    }>;
    expect(els).toHaveLength(2);

    // value は { reviewId, channelId } の JSON
    const expectedValue = JSON.stringify({
      reviewId: "rev-1",
      channelId: "C-1",
    });

    expect(els[0]).toEqual({
      type: "button",
      action_id: "sticky_pr_done_rev-1",
      text: { type: "plain_text", text: "✓ 強制完了" },
      value: expectedValue,
      confirm: {
        title: { type: "plain_text", text: "強制完了" },
        text: {
          type: "mrkdwn",
          text: "このレビュー依頼を完了（マージ済）にします。よろしいですか？",
        },
        confirm: { type: "plain_text", text: "完了にする" },
        deny: { type: "plain_text", text: "キャンセル" },
      },
    });
    expect(els[0]).not.toHaveProperty("style");

    expect(els[1]).toEqual({
      type: "button",
      action_id: "sticky_pr_rereview_rev-1",
      text: { type: "plain_text", text: "🔄 再レビュー依頼" },
      value: expectedValue,
      style: "danger",
      confirm: {
        title: { type: "plain_text", text: "再レビュー依頼" },
        text: {
          type: "mrkdwn",
          text: "LGTM をリセットして再レビュー依頼します。よろしいですか？",
        },
        confirm: { type: "plain_text", text: "依頼する" },
        deny: { type: "plain_text", text: "キャンセル" },
      },
    });
  });

  it("action_id は reviewId を含む (sticky_pr_done_<id> / sticky_pr_rereview_<id>)", () => {
    const v = buildPRReviewEditModal({
      reviewId: "rev-XYZ",
      eventId: "ev-1",
      channelId: "C-1",
      title: "T",
      reviewerSlackIds: [],
    }) as AnyView;
    const els = v.blocks[5].elements as Array<{ action_id: string }>;
    expect(els[0].action_id).toBe("sticky_pr_done_rev-XYZ");
    expect(els[1].action_id).toBe("sticky_pr_rereview_rev-XYZ");
  });

  it("view 全体スナップショット (prefill 有り)", () => {
    expect(
      buildPRReviewEditModal({
        reviewId: "rev-1",
        eventId: "ev-1",
        channelId: "C-1",
        title: "PR タイトル",
        description: "説明文",
        url: "https://example.com/pr/1",
        reviewerSlackIds: ["U-1", "U-2"],
      }),
    ).toMatchInlineSnapshot(`
      {
        "blocks": [
          {
            "block_id": "title_block",
            "element": {
              "action_id": "title_input",
              "initial_value": "PR タイトル",
              "max_length": 200,
              "type": "plain_text_input",
            },
            "label": {
              "text": "タイトル",
              "type": "plain_text",
            },
            "type": "input",
          },
          {
            "block_id": "desc_block",
            "element": {
              "action_id": "desc_input",
              "initial_value": "説明文",
              "max_length": 2000,
              "multiline": true,
              "type": "plain_text_input",
            },
            "label": {
              "text": "詳細（説明）",
              "type": "plain_text",
            },
            "optional": true,
            "type": "input",
          },
          {
            "block_id": "url_block",
            "element": {
              "action_id": "url_input",
              "initial_value": "https://example.com/pr/1",
              "type": "plain_text_input",
            },
            "label": {
              "text": "参考リンク",
              "type": "plain_text",
            },
            "optional": true,
            "type": "input",
          },
          {
            "block_id": "reviewer_block",
            "element": {
              "action_id": "reviewer_input",
              "initial_users": [
                "U-1",
                "U-2",
              ],
              "max_selected_items": 5,
              "placeholder": {
                "text": "レビュアーを選択",
                "type": "plain_text",
              },
              "type": "multi_users_select",
            },
            "label": {
              "text": "レビュアー（最大5人）",
              "type": "plain_text",
            },
            "optional": true,
            "type": "input",
          },
          {
            "type": "divider",
          },
          {
            "elements": [
              {
                "action_id": "sticky_pr_done_rev-1",
                "confirm": {
                  "confirm": {
                    "text": "完了にする",
                    "type": "plain_text",
                  },
                  "deny": {
                    "text": "キャンセル",
                    "type": "plain_text",
                  },
                  "text": {
                    "text": "このレビュー依頼を完了（マージ済）にします。よろしいですか？",
                    "type": "mrkdwn",
                  },
                  "title": {
                    "text": "強制完了",
                    "type": "plain_text",
                  },
                },
                "text": {
                  "text": "✓ 強制完了",
                  "type": "plain_text",
                },
                "type": "button",
                "value": "{"reviewId":"rev-1","channelId":"C-1"}",
              },
              {
                "action_id": "sticky_pr_rereview_rev-1",
                "confirm": {
                  "confirm": {
                    "text": "依頼する",
                    "type": "plain_text",
                  },
                  "deny": {
                    "text": "キャンセル",
                    "type": "plain_text",
                  },
                  "text": {
                    "text": "LGTM をリセットして再レビュー依頼します。よろしいですか？",
                    "type": "mrkdwn",
                  },
                  "title": {
                    "text": "再レビュー依頼",
                    "type": "plain_text",
                  },
                },
                "style": "danger",
                "text": {
                  "text": "🔄 再レビュー依頼",
                  "type": "plain_text",
                },
                "type": "button",
                "value": "{"reviewId":"rev-1","channelId":"C-1"}",
              },
            ],
            "type": "actions",
          },
        ],
        "callback_id": "sticky_pr_review_edit_submit",
        "close": {
          "text": "閉じる",
          "type": "plain_text",
        },
        "private_metadata": "{"reviewId":"rev-1","eventId":"ev-1","channelId":"C-1"}",
        "submit": {
          "text": "保存",
          "type": "plain_text",
        },
        "title": {
          "text": "レビュー依頼を編集",
          "type": "plain_text",
        },
        "type": "modal",
      }
    `);
  });
});

// ---------------------------------------------------------------------------
// jstDateTimeToUtcIso (pure)
// ---------------------------------------------------------------------------
describe("jstDateTimeToUtcIso (現状固定)", () => {
  it("時刻指定: JST 壁時計から 9 時間引いた UTC ISO", () => {
    // 2026-05-20 19:00 JST → 10:00 UTC
    expect(jstDateTimeToUtcIso("2026-05-20", "19:00")).toBe(
      "2026-05-20T10:00:00.000Z",
    );
  });

  it("時刻 null → 09:00 JST 既定 → 00:00 UTC", () => {
    expect(jstDateTimeToUtcIso("2026-05-20", null)).toBe(
      "2026-05-20T00:00:00.000Z",
    );
  });

  it("JST 早朝は前日 UTC に繰り上がる (00:00 JST → 前日 15:00 UTC)", () => {
    expect(jstDateTimeToUtcIso("2026-05-20", "00:00")).toBe(
      "2026-05-19T15:00:00.000Z",
    );
  });
});
