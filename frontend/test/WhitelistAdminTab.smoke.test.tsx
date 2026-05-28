import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WhitelistAdminTab } from "../src/components/whitelist/WhitelistAdminTab";

// 宗教イベント PR6: WhitelistAdminTab の smoke。
// - メンバー一覧が提出状況 (提出済 / 未提出) 付きで描画される
// - 「メンバー同期」で POST members/sync が打たれる
// - 全会一致結果セクションが描画される
// - 「リンクをコピー」で /whitelist/:token URL が clipboard に渡る (token は画面に出さない)

const EVENT_ID = "ev1";
const ACTION_ID = "act-wl";

type FetchCall = { url: string; method: string };

const MEMBERS = [
  { id: "m1", displayName: "山田 太郎", submitted: true, submittedAt: "2026-05-20T09:30:00Z", token: "tok-aaa" },
  { id: "m2", displayName: "鈴木 花子", submitted: false, submittedAt: null, token: "tok-bbb" },
];
const RESULTS = [
  { nameNormalized: "さとうはなこ", notifiedAt: "2026-05-21T10:00:00Z" },
];

function installFetchSpy(opts?: {
  members?: typeof MEMBERS;
  results?: typeof RESULTS;
}): FetchCall[] {
  const calls: FetchCall[] = [];
  const members = opts?.members ?? MEMBERS;
  const results = opts?.results ?? RESULTS;
  function json(body: unknown) {
    return new Response(JSON.stringify(body), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/whitelist/members/sync")) return json(members);
      if (url.includes("/whitelist/members")) return json(members);
      if (url.includes("/whitelist/results")) return json(results);
      return json({ ok: true });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WhitelistAdminTab smoke (宗教 PR6)", () => {
  it("メンバーを提出状況付きで描画する", async () => {
    installFetchSpy();
    render(<WhitelistAdminTab eventId={EVENT_ID} actionId={ACTION_ID} />);
    expect(await screen.findByText("山田 太郎")).toBeInTheDocument();
    expect(screen.getByText(/✅ 提出済/)).toBeInTheDocument();
    expect(screen.getByText("鈴木 花子")).toBeInTheDocument();
    expect(screen.getByText(/⚪ 未提出/)).toBeInTheDocument();
  });

  it("全会一致結果セクションを描画する", async () => {
    installFetchSpy();
    render(<WhitelistAdminTab eventId={EVENT_ID} actionId={ACTION_ID} />);
    expect(await screen.findByText("さとうはなこ")).toBeInTheDocument();
  });

  it("全会一致が無ければ空状態を出す", async () => {
    installFetchSpy({ results: [] });
    render(<WhitelistAdminTab eventId={EVENT_ID} actionId={ACTION_ID} />);
    expect(await screen.findByText(/まだ全会一致はありません/)).toBeInTheDocument();
  });

  it("「メンバー同期」で POST members/sync が打たれる", async () => {
    const calls = installFetchSpy();
    const user = userEvent.setup();
    render(<WhitelistAdminTab eventId={EVENT_ID} actionId={ACTION_ID} />);
    await screen.findByText("山田 太郎");
    await user.click(screen.getByRole("button", { name: "メンバー同期" }));
    await waitFor(() => {
      const post = calls.find(
        (c) => c.method === "POST" && c.url.includes("/whitelist/members/sync"),
      );
      expect(post).toBeDefined();
    });
  });

  it("「リンクをコピー」で /whitelist/:token URL を clipboard に渡す (token は非表示)", async () => {
    installFetchSpy();
    // navigator 全体を差し替えると userEvent の内部 clipboard と競合するため、
    // clipboard.writeText だけを defineProperty で差し込み fireEvent で click する。
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText }, configurable: true, writable: true,
    });
    render(<WhitelistAdminTab eventId={EVENT_ID} actionId={ACTION_ID} />);
    await screen.findByText("山田 太郎");
    // token は生テキストとして描画されない
    expect(screen.queryByText(/tok-aaa/)).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "山田 太郎 の提出リンクをコピー" }),
    );
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        `${window.location.origin}/whitelist/tok-aaa`,
      );
    });
  });
});
