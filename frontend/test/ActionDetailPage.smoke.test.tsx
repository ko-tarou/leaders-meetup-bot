import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { Routes, Route } from "react-router-dom";
import { ActionDetailPage } from "../src/pages/ActionDetailPage";
import type { Event, EventAction } from "../src/types";
import { renderWithProviders } from "./util";

// Phase4-0 characterization スモーク。
// ActionDetailPage は Phase4 で分割予定 (754 行)。本テストは「現状のまま
// 主要描画が壊れず出る」ことを固定する番人。ピクセル一致ではなく
// パンくず / 見出し / サブタブ一覧の存在を assert する。

const EVENT_ID = "ev1";

const event: Event = {
  id: EVENT_ID,
  type: "project",
  name: "テストイベント",
  config: "{}",
  status: "active",
  createdAt: "2026-01-01T00:00:00Z",
};

function makeAction(actionType: EventAction["actionType"]): EventAction {
  return {
    id: `act-${actionType}`,
    eventId: EVENT_ID,
    actionType,
    config: "{}",
    enabled: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function renderActionPage(actionType: EventAction["actionType"]) {
  return renderWithProviders(
    <Routes>
      <Route
        path="/events/:eventId/actions/:actionType"
        element={<ActionDetailPage />}
      />
    </Routes>,
    {
      initialEntries: [`/events/${EVENT_ID}/actions/${actionType}`],
      routes: {
        "/orgs": [event],
        [`/orgs/${EVENT_ID}/actions`]: [makeAction(actionType)],
        // 子コンポーネントが叩く一覧系は空配列でフォールバック (util の既定)
      },
    },
  );
}

describe("ActionDetailPage smoke (Phase4-0 番人)", () => {
  it("member_application: 主要見出しとパンくずが render される", async () => {
    renderActionPage("member_application");
    expect(
      await screen.findByRole("heading", { name: /新メンバー入会/ }),
    ).toBeInTheDocument();
    // パンくず先頭の「ホーム」リンク
    expect(screen.getByRole("link", { name: "ホーム" })).toBeInTheDocument();
  });

  it("member_application: 全 7 サブタブのラベルが出る", async () => {
    renderActionPage("member_application");
    await screen.findByRole("heading", { name: /新メンバー入会/ });
    for (const label of [
      "メイン",
      "面接官",
      "カレンダー",
      "メール",
      "参加届",
      "通知",
      "その他設定",
    ]) {
      expect(
        screen.getByRole("button", { name: label }),
      ).toBeInTheDocument();
    }
  });

  it("task_management: メイン / チャンネル管理 / その他設定 の 3 タブ", async () => {
    renderActionPage("task_management");
    await screen.findByRole("heading", { name: /タスク管理/ });
    for (const label of ["メイン", "チャンネル管理", "その他設定"]) {
      expect(
        screen.getByRole("button", { name: label }),
      ).toBeInTheDocument();
    }
  });

  it("role_management: 5 サブタブが出る", async () => {
    renderActionPage("role_management");
    await screen.findByRole("heading", { name: /ロール管理/ });
    for (const label of [
      "メイン",
      "ロール",
      "メンバー名簿",
      "同期",
      "その他設定",
    ]) {
      expect(
        screen.getByRole("button", { name: label }),
      ).toBeInTheDocument();
    }
  });

  it("schedule_polling: 5 サブタブが出る", async () => {
    renderActionPage("schedule_polling");
    await screen.findByRole("heading", { name: /日程調整/ });
    for (const label of [
      "メイン",
      "チャンネル設定",
      "候補設定",
      "リマインド設定",
      "手動アクション",
    ]) {
      expect(
        screen.getByRole("button", { name: label }),
      ).toBeInTheDocument();
    }
  });

  it("weekly_reminder: サブタブ無し + 有効化/削除ボタンが出る", async () => {
    renderActionPage("weekly_reminder");
    await screen.findByRole("heading", { name: /週次リマインド/ });
    // weekly_reminder はサブタブを廃止し一覧 UX。トグル/削除は末尾に出る。
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "削除" }),
      ).toBeInTheDocument();
    });
  });

  it("不正な eventId/actionType でも throw せず描画が完了する", async () => {
    // action が見つからない場合は /events/:id/actions へ Navigate。
    // 例外を投げず安全に解決することを確認する。
    renderWithProviders(
      <Routes>
        <Route
          path="/events/:eventId/actions/:actionType"
          element={<ActionDetailPage />}
        />
        <Route
          path="/events/:eventId/actions"
          element={<div>アクション一覧</div>}
        />
      </Routes>,
      {
        initialEntries: [`/events/${EVENT_ID}/actions/task_management`],
        routes: { "/orgs": [event], [`/orgs/${EVENT_ID}/actions`]: [] },
      },
    );
    await waitFor(() => {
      expect(screen.getByText("アクション一覧")).toBeInTheDocument();
    });
  });
});
