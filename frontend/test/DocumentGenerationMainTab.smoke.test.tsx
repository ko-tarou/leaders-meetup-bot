import { describe, it, expect, afterEach, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "./util";
import { DocumentGenerationMainTab } from "../src/components/document-generation/DocumentGenerationMainTab";
import type { EventAction } from "../src/types";

// document_generation「名簿生成」タブの最小スモーク。
//
// 確認項目:
//   - roster エンドポイントの結果から チーム別テーブル + メンバーが描画される
//   - 「名簿生成」サブタブ見出しと「PDF をダウンロード」ボタンが出る
//   - クラス列が 学年+学科 に整形される
// PDF 生成 (html2canvas/jspdf) は click 時 dynamic import なので描画では走らない。

const action: EventAction = {
  id: "act-1",
  eventId: "ev-1",
  actionType: "document_generation",
  config: "{}",
  enabled: 1,
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z",
};

const rosterDoc = {
  generatedAt: "2026-07-28T01:23:00.000Z",
  totalMembers: 1,
  hasRoleManagement: true,
  roles: [
    {
      roleId: "role-front",
      roleName: "フロント班",
      members: [
        {
          formId: "f-1",
          name: "田中太郎",
          nameKana: "タナカタロウ",
          grade: "3",
          department: "情報工学科",
          studentId: null,
          email: "tanaka@example.com",
          desiredActivity: null,
          devRoles: [],
        },
      ],
    },
  ],
  unassigned: [],
};

describe("DocumentGenerationMainTab", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("roster を取得してチーム別に描画し、PDF ボタンを出す", async () => {
    renderWithProviders(
      <DocumentGenerationMainTab eventId="ev-1" action={action} />,
      { routes: { "/document/roster": rosterDoc } },
    );

    // チーム名 + メンバー + 整形済みクラスが描画される。
    expect(await screen.findByText("田中太郎")).toBeTruthy();
    // 「フロント班」はチーム見出し + 所属チーム列の 2 箇所に出る。
    expect(screen.getAllByText(/フロント班/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("3年 情報工学科")).toBeTruthy();
    expect(screen.getByText("tanaka@example.com")).toBeTruthy();

    // 名簿生成サブタブ見出し + PDF ボタン。
    expect(screen.getByText("名簿生成")).toBeTruthy();
    expect(screen.getByText(/PDF をダウンロード/)).toBeTruthy();
  });
});
