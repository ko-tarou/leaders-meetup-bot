import { describe, it, expect, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
