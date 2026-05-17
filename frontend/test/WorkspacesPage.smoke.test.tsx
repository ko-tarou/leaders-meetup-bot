import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route } from "react-router-dom";
import { WorkspacesPage } from "../src/pages/WorkspacesPage";
import type { AppSettings, GmailAccount, Workspace } from "../src/types";
import {
  AppProviders,
  renderWithProviders,
  type FetchRoutes,
} from "./util";

// 任意の fetch ハンドラを「render より前」に stub してから AppProviders で
// 描画する。renderWithProviders は内部で installFetchMock を呼び stub を
// 上書きするため、エラー注入や呼び出し計測が必要なケースはこちらを使う。
function renderWithFetch(
  handler: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
  initialEntries: string[] = ["/workspaces"],
) {
  vi.stubGlobal("fetch", vi.fn(handler));
  return render(
    <AppProviders initialEntries={initialEntries}>
      <Routes>
        <Route path="/workspaces" element={<WorkspacesPage />} />
        <Route path="/" element={<div>ホーム画面</div>} />
      </Routes>
    </AppProviders>,
  );
}

// Phase4-7 characterization スモーク (番人)。
// WorkspacesPage は 631 行 + smoke 未整備。純抽出に着手する前に「現状の
// 主要観測面」をここで固定する (true characterization)。
//
// 観測面:
//   - loading / error
//   - 戻るボタン (history>1 → navigate(-1) / history<=1 → "/")
//   - workspace 一覧 (件数見出し / 空状態 / 各カード情報 / bot 一括招待 / 削除)
//   - 削除 confirm OK/キャンセル
//   - Gmail 連携セクション (件数 / 空状態 / 各アカウント / 解除 confirm)
//   - FeedbackSettingsSection の存在 (子コンポーネント wiring)
//   - 手動登録フォームのトグル開閉とバリデーション
//   - ?installed= / ?gmail_connected= callback の成功表示
//
// 本ファイルは「抽出前のコード」で green 化し、抽出後も同一 assert が green で
// あることを保証する (挙動 byte-identical の番人)。

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ws1: Workspace = {
  id: "ws1",
  name: "DevHub WS",
  slackTeamId: "T123",
  createdAt: "2026-01-02T03:04:05Z",
};

const wsDefault: Workspace = {
  id: "ws_default",
  name: "Default WS",
  slackTeamId: "T000",
  createdAt: "2026-01-01T00:00:00Z",
};

const gmail1: GmailAccount = {
  id: "g1",
  email: "sender@example.com",
  createdAt: "2026-01-03T00:00:00Z",
  updatedAt: "2026-01-03T00:00:00Z",
};

const appSettings: AppSettings = {
  feedbackEnabled: false,
  feedbackWorkspaceId: null,
  feedbackChannelId: null,
  feedbackChannelName: null,
  feedbackMentionUserIds: [],
  aiChatEnabled: false,
  updatedAt: "2026-01-01T00:00:00Z",
};

function renderPage(
  opts: { initialEntries?: string[]; routes?: FetchRoutes } = {},
) {
  return renderWithProviders(
    <Routes>
      <Route path="/workspaces" element={<WorkspacesPage />} />
      <Route path="/" element={<div>ホーム画面</div>} />
    </Routes>,
    {
      initialEntries: opts.initialEntries ?? ["/workspaces"],
      routes: {
        "/workspaces": [ws1],
        "/gmail-accounts": [],
        "/app-settings": appSettings,
        ...opts.routes,
      },
    },
  );
}

// list ロード完了の安定アンカー。card の team_id 行は WS 一覧専用なので
// FeedbackSettingsSection の <option> と衝突しない。
async function waitForLoaded() {
  await screen.findByText(/team_id: /);
}

describe("WorkspacesPage smoke (Phase4-7 番人)", () => {
  it("loading: 初期は「読み込み中...」が出る", () => {
    renderPage();
    expect(screen.getByText("読み込み中...")).toBeInTheDocument();
  });

  it("一覧: 件数見出しと workspace カード情報が出る", async () => {
    renderPage();
    expect(
      await screen.findByRole("heading", {
        name: "ワークスペース管理 (1件)",
      }),
    ).toBeInTheDocument();
    // "DevHub WS" は card の <strong> と Feedback の <option> 双方に出る
    // (現状の振る舞い)。card 側の存在を team_id 行で固定する。
    expect(
      screen.getByText("team_id: T123 / 登録日: 2026-01-02"),
    ).toBeInTheDocument();
    // OAuth インストールリンク
    expect(
      screen.getByRole("link", { name: "+ Slack でインストール" }),
    ).toHaveAttribute("href", "/slack/oauth/install");
  });

  it("空状態: workspace 0 件でプレースホルダ文言", async () => {
    renderPage({ routes: { "/workspaces": [] } });
    expect(
      await screen.findByText(
        /ワークスペースが登録されていません/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "ワークスペース管理 (0件)" }),
    ).toBeInTheDocument();
  });

  it("error: list が reject すると「エラー: ...」が出る", async () => {
    renderWithFetch(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/workspaces")) throw new Error("boom");
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    await waitFor(() => {
      expect(screen.getByText("エラー: boom")).toBeInTheDocument();
    });
  });

  it("ws_default の削除ボタンは disabled", async () => {
    renderPage({ routes: { "/workspaces": [wsDefault] } });
    await screen.findByText("Default WS");
    const delBtn = screen.getByRole("button", { name: "削除" });
    expect(delBtn).toBeDisabled();
  });

  it("削除 confirm OK で list が再取得される", async () => {
    const user = userEvent.setup();
    let listCalls = 0;
    renderWithFetch(async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const path = url.split("?")[0];
      const method = init?.method ?? "GET";
      if (path.endsWith("/workspaces/ws1") && method === "DELETE") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (path.endsWith("/workspaces") && method === "GET") {
        listCalls++;
        return new Response(JSON.stringify([ws1]), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    await waitForLoaded();
    expect(listCalls).toBe(1);
    await user.click(screen.getByRole("button", { name: "削除" }));
    // ConfirmDialog (custom) が出る
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "削除" }));
    await waitFor(() => {
      expect(listCalls).toBeGreaterThanOrEqual(2);
    });
  });

  it("削除 confirm キャンセルで list 再取得されない", async () => {
    const user = userEvent.setup();
    let listCalls = 0;
    renderWithFetch(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const path = url.split("?")[0];
      if (path.endsWith("/workspaces")) {
        listCalls++;
        return new Response(JSON.stringify([ws1]), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    await waitForLoaded();
    await user.click(screen.getByRole("button", { name: "削除" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "キャンセル" }),
    );
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(listCalls).toBe(1);
  });

  it("bot 一括招待ボタンが各カードに出る", async () => {
    renderPage();
    await waitForLoaded();
    expect(
      screen.getByRole("button", { name: "bot を一括招待" }),
    ).toBeInTheDocument();
  });

  it("Gmail 連携: 空状態の見出しとプレースホルダ", async () => {
    renderPage();
    await waitForLoaded();
    expect(
      screen.getByRole("heading", { name: "Gmail 連携 (0件)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/未連携です。/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "+ Gmail を連携" }),
    ).toBeInTheDocument();
  });

  it("Gmail 連携: アカウントがあるとカードが出る", async () => {
    renderPage({ routes: { "/gmail-accounts": [gmail1] } });
    await waitForLoaded();
    expect(
      screen.getByRole("heading", { name: "Gmail 連携 (1件)" }),
    ).toBeInTheDocument();
    expect(screen.getByText("sender@example.com")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "解除" }),
    ).toBeInTheDocument();
  });

  it("FeedbackSettingsSection が wiring されている", async () => {
    renderPage();
    await waitForLoaded();
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "フィードバック設定" }),
      ).toBeInTheDocument();
    });
  });

  it("手動登録: ボタンクリックでフォームが開く", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForLoaded();
    expect(
      screen.queryByText("ワークスペース手動登録"),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "手動登録（上級者向け）" }),
    );
    expect(
      screen.getByText("ワークスペース手動登録"),
    ).toBeInTheDocument();
  });

  it("手動登録: 必須未入力だと登録ボタンが disabled", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForLoaded();
    await user.click(
      screen.getByRole("button", { name: "手動登録（上級者向け）" }),
    );
    expect(screen.getByRole("button", { name: "登録" })).toBeDisabled();
  });

  it("手動登録: Bot Token/Signing Secret 入力で登録ボタンが有効化", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForLoaded();
    await user.click(
      screen.getByRole("button", { name: "手動登録（上級者向け）" }),
    );
    await user.type(screen.getByPlaceholderText("xoxb-..."), "xoxb-abc");
    const inputs = screen.getAllByDisplayValue("");
    // Signing Secret は placeholder 無しの password input
    const signing = inputs.find(
      (el) =>
        (el as HTMLInputElement).type === "password" &&
        !(el as HTMLInputElement).placeholder,
    ) as HTMLInputElement;
    await user.type(signing, "secret-xyz");
    expect(screen.getByRole("button", { name: "登録" })).toBeEnabled();
  });

  it("手動登録: キャンセルでフォームが閉じる", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForLoaded();
    await user.click(
      screen.getByRole("button", { name: "手動登録（上級者向け）" }),
    );
    await user.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(
      screen.queryByText("ワークスペース手動登録"),
    ).not.toBeInTheDocument();
  });

  it("?installed= callback で成功メッセージが出る", async () => {
    renderPage({
      initialEntries: ["/workspaces?installed=MyTeam"],
    });
    await waitForLoaded();
    expect(
      screen.getByText("「MyTeam」を登録しました"),
    ).toBeInTheDocument();
  });

  it("?gmail_connected= callback で成功 toast が出る", async () => {
    renderPage({
      initialEntries: ["/workspaces?gmail_connected=1&email=a@b.com"],
    });
    await waitFor(() => {
      expect(
        screen.getByText("Gmail を連携しました: a@b.com"),
      ).toBeInTheDocument();
    });
  });

  it("戻るボタン: 履歴が無いとき / へフォールバック", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForLoaded();
    await user.click(
      screen.getByRole("button", { name: /元の画面に戻る/ }),
    );
    // MemoryRouter は history.length が 1 のため "/" へ
    await waitFor(() => {
      expect(screen.getByText("ホーム画面")).toBeInTheDocument();
    });
  });
});
