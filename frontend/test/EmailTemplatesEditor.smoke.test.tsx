import { describe, it, expect, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { EmailTemplatesEditor } from "../src/components/EmailTemplatesEditor";
import type { EventAction, EmailTemplate } from "../src/types";
import { installFetchMock } from "./util";

// Phase4-0 characterization スモーク。
// EmailTemplatesEditor は 2091 行で Phase4 最大の分割対象。
// 「テンプレ一覧 / 編集領域 / placeholder 説明 / 自動送信設定」という
// ユーザーが見る主要描画を分割前に固定する番人。

afterEach(() => {
  vi.unstubAllGlobals();
});

const baseAction: EventAction = {
  id: "act-ma",
  eventId: "ev1",
  actionType: "member_application",
  config: "{}",
  enabled: 1,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function actionWithTemplates(templates: EmailTemplate[]): EventAction {
  return { ...baseAction, config: JSON.stringify({ emailTemplates: templates }) };
}

function renderEditor(action: EventAction) {
  installFetchMock({ "/gmail-accounts": [] });
  return render(
    <EmailTemplatesEditor eventId="ev1" action={action} onChange={() => {}} />,
  );
}

describe("EmailTemplatesEditor smoke (Phase4-0 番人)", () => {
  it("空 config でも throw せず主要見出しが出る", () => {
    renderEditor(baseAction);
    expect(
      screen.getByRole("heading", { name: "メールテンプレート管理" }),
    ).toBeInTheDocument();
  });

  it("placeholder 説明 (プレースホルダ) が render される", () => {
    renderEditor(baseAction);
    // placeholder 反映の観測可能点: ヘルプボックスの「プレースホルダ:」
    expect(screen.getByText(/プレースホルダ/)).toBeInTheDocument();
    expect(screen.getByText("{name}")).toBeInTheDocument();
    expect(screen.getByText("{interviewAt}")).toBeInTheDocument();
  });

  it("自動送信設定セクションが出る", () => {
    renderEditor(baseAction);
    expect(screen.getByText("自動送信設定")).toBeInTheDocument();
    expect(screen.getByText("送信トリガー")).toBeInTheDocument();
  });

  it("既存テンプレ名が編集領域に反映される", () => {
    const action = actionWithTemplates([
      { id: "t1", name: "面談確定の連絡", subject: "件名A", body: "本文A" },
      { id: "t2", name: "合格通知", subject: "件名B", body: "本文B" },
    ]);
    renderEditor(action);
    expect(
      screen.getByDisplayValue("面談確定の連絡"),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("合格通知")).toBeInTheDocument();
  });

  it("gmail アカウント fetch 完了後に未連携メッセージが出る", async () => {
    renderEditor(baseAction);
    await waitFor(() => {
      expect(
        screen.getByText(/未連携 — ワークスペース管理から連携してください/),
      ).toBeInTheDocument();
    });
  });

  it("壊れた config (不正 JSON) でも throw せず描画される", () => {
    const broken: EventAction = { ...baseAction, config: "{ not json" };
    renderEditor(broken);
    // parseInitialTemplates の catch でフォールバックし描画は継続する
    expect(
      screen.getByRole("heading", { name: "メールテンプレート管理" }),
    ).toBeInTheDocument();
  });
});

// Phase4-4 番人 (分割対象サブツリーの観測面固定)。
// 本PRで純抽出する subtree:
//   1. parsers/constants (parseInitial* / TRIGGER_DEFS / DEFAULT_* / renderLogTemplate)
//   2. styles (純 CSS)
//   3. LogToSlackSection (子コンポーネント。props 配線のみ)
// 分割前後で観測可能挙動が一字一句変わらないことを保証する。
describe("EmailTemplatesEditor smoke (Phase4-4 分割対象 番人)", () => {
  it("parseInitialAutoSend: triggers.onSubmit が trigger select に反映される", () => {
    const action: EventAction = {
      ...baseAction,
      config: JSON.stringify({
        emailTemplates: [
          { id: "t1", name: "面談確定の連絡", subject: "件名A", body: "本文A" },
        ],
        autoSendEmail: {
          enabled: true,
          gmailAccountId: "g1",
          triggers: { onSubmit: "t1" },
        },
      }),
    };
    renderEditor(action);
    // 自動送信トグルが ON で render される (parseInitialAutoSend.enabled)
    const autoSendToggle = screen
      .getByText("自動送信設定")
      .closest("div")
      ?.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(autoSendToggle.checked).toBe(true);
    // 「応募完了時」trigger の select が t1 を選択している。
    // 一致する要素: テンプレ名 input + onSubmit select (他 trigger は「送信しない」) = 2
    expect(screen.getByText("応募完了時")).toBeInTheDocument();
    expect(screen.getAllByDisplayValue("面談確定の連絡").length).toBe(2);
  });

  it("parseInitialAutoSend: 旧 templateId は onSubmit に fallback して render", () => {
    const action: EventAction = {
      ...baseAction,
      config: JSON.stringify({
        emailTemplates: [{ id: "legacy", name: "旧テンプレ", body: "b" }],
        autoSendEmail: { enabled: true, templateId: "legacy" },
      }),
    };
    renderEditor(action);
    // 旧 templateId が onSubmit へ fallback され、onSubmit select が選択状態。
    // 一致: テンプレ名 input + onSubmit select = 2 (他 trigger は「送信しない」)
    expect(screen.getAllByDisplayValue("旧テンプレ").length).toBe(2);
  });

  it("parseInitialSlackInvites: 旧 slackInvite (単数) を一覧に表示する", () => {
    const action: EventAction = {
      ...baseAction,
      config: JSON.stringify({
        slackInvite: { url: "https://join.slack.com/t/x/zt-legacy" },
      }),
    };
    renderEditor(action);
    expect(screen.getByText(/1 件登録/)).toBeInTheDocument();
  });

  it("LogToSlackSection: 有効化トグルで通知先 / メンション / メッセージが現れる", async () => {
    const user = userEvent.setup();
    renderEditor(baseAction);
    const logSection = screen.getByText("Slack ログ通知").closest("div")!
      .parentElement as HTMLElement;
    const toggle = within(logSection).getByRole("checkbox");
    expect(within(logSection).queryByText("通知先")).not.toBeInTheDocument();
    await user.click(toggle);
    expect(within(logSection).getByText("通知先")).toBeInTheDocument();
    expect(within(logSection).getByText("メンション")).toBeInTheDocument();
    // デフォルトログテンプレ文面が表示される (renderLogTemplate / DEFAULT_LOG_TEMPLATE)
    expect(
      within(logSection).getByText(/メッセージ \(デフォルト\)/),
    ).toBeInTheDocument();
  });

  it("LogToSlackSection: メッセージ編集でプレースホルダ一覧とプレビューが出る", async () => {
    const user = userEvent.setup();
    renderEditor(baseAction);
    const logSection = screen.getByText("Slack ログ通知").closest("div")!
      .parentElement as HTMLElement;
    await user.click(within(logSection).getByRole("checkbox"));
    // メッセージ行の「編集」ボタン (3番目の編集: 通知先/メンション/メッセージ)
    const editBtns = within(logSection).getAllByRole("button", {
      name: "編集",
    });
    await user.click(editBtns[editBtns.length - 1]);
    // LOG_PLACEHOLDERS の key がプレースホルダ一覧に出る
    expect(within(logSection).getByText("{mentions}")).toBeInTheDocument();
    expect(within(logSection).getByText("{triggerLabel}")).toBeInTheDocument();
    // プレビュー: LOG_SAMPLE_VARS で置換された文面 (renderLogTemplate)
    expect(within(logSection).getByText("プレビュー")).toBeInTheDocument();
    expect(within(logSection).getByText(/鈴木 太郎/)).toBeInTheDocument();
  });

  it("4 trigger ラベル (TRIGGER_DEFS) がすべて描画される", () => {
    renderEditor(baseAction);
    expect(screen.getByText("応募完了時")).toBeInTheDocument();
    expect(screen.getByText("面接予定時")).toBeInTheDocument();
    expect(screen.getByText("合格時")).toBeInTheDocument();
    expect(screen.getByText("不合格時")).toBeInTheDocument();
  });
});
