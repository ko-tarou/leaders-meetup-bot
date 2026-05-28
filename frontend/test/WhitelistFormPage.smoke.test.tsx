import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ToastProvider } from "../src/components/ui/Toast";
import { WhitelistFormPage } from "../src/pages/WhitelistFormPage";

// 宗教イベント PR5: whitelist メンバー向け非公開フォームのスモーク。
//
// WhitelistFormPage は admin token を持たない公開ページで、token ベースの
// 直 fetch (GET で prefill / POST で全置換) を行う。ここでは fetch を
// stub し、(1) prefill 表示 (2) 行の追加/削除 (3) 送信 body の検証 を固定する。

const TOKEN = "tok-123";

/** /whitelist/:token を MemoryRouter + ToastProvider で render する。 */
function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/whitelist/${TOKEN}`]}>
      <ToastProvider>
        <Routes>
          <Route path="/whitelist/:token" element={<WhitelistFormPage />} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

/** JSON レスポンスを返す Response を組み立てる小道具。 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("WhitelistFormPage smoke (宗教 PR5)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("404 のとき「リンクが無効」案内を出す", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "invalid_token" }, 404)),
    );
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent(/リンクが無効/);
  });

  it("prefill した名前を表示し、displayName で挨拶する", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ displayName: "山田 太郎", names: ["佐藤 花子"] }),
      ),
    );
    renderPage();
    expect(
      await screen.findByRole("heading", { name: /山田 太郎/ }),
    ).toBeInTheDocument();
    // prefill された名前が input に出る
    expect(screen.getByDisplayValue("佐藤 花子")).toBeInTheDocument();
    // プライバシー安心文言が出る
    expect(
      screen.getByText(/運営や他のメンバーには公開されません/),
    ).toBeInTheDocument();
  });

  it("名前ゼロのとき空状態を出し、行追加できる", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ displayName: "鈴木 一郎", names: [] })),
    );
    renderPage();
    expect(await screen.findByText(/まだ登録されていません/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "+ 名前を追加" }));
    expect(screen.getByLabelText("名前 1")).toBeInTheDocument();
  });

  it("行を削除できる", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ displayName: "高橋 次郎", names: ["A 太郎", "B 花子"] }),
      ),
    );
    renderPage();
    await screen.findByDisplayValue("A 太郎");
    await userEvent.click(screen.getByRole("button", { name: "名前 1 を削除" }));
    // 残るのは "B 花子" のみ
    expect(screen.queryByDisplayValue("A 太郎")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("B 花子")).toBeInTheDocument();
  });

  it("送信で trim + 空行除去した names を POST する", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse({ ok: true, count: 2 });
      }
      // GET prefill: 1 件 prefill + 後で空行を足して送信する
      return jsonResponse({ displayName: "本人", names: ["佐藤 花子 "] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    // prefill された 1 行目を取得 (testing-library は値の前後空白を正規化するため
    // exact:false で照合する)。
    const first = await screen.findByDisplayValue("佐藤 花子", { exact: false });

    // 2 行目を追加し別の名前を入れる
    await userEvent.click(screen.getByRole("button", { name: "+ 名前を追加" }));
    await userEvent.type(screen.getByLabelText("名前 2"), "田中 三郎");
    // 3 行目を追加して空のまま (送信時に除外されるべき)
    await userEvent.click(screen.getByRole("button", { name: "+ 名前を追加" }));

    await userEvent.click(screen.getByRole("button", { name: "保存する" }));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "POST",
      );
      expect(postCall).toBeDefined();
    });

    const postCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    );
    const [url, init] = postCall as [string, RequestInit];
    expect(url).toContain(`/api/whitelist/${TOKEN}`);
    expect(JSON.parse(init.body as string)).toEqual({
      names: ["佐藤 花子", "田中 三郎"],
    });

    // 成功表示 (success ボックス。toast はテストで描画されないことがあるため
    // 永続表示の success ボックスで確認する)。
    expect(await screen.findByText(/同じ URL を使って/)).toBeInTheDocument();
    // 第一行はサーバ正規化済み (trim) の値に揃う
    expect(first).toHaveValue("佐藤 花子");
  });
});
