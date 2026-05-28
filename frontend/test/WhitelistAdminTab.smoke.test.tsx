import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WhitelistAdminTab } from "../src/components/whitelist/WhitelistAdminTab";

// 宗教イベント PR8: WhitelistAdminTab の smoke。
// - メンバー一覧が提出状況 (提出済 / 未提出) 付きで描画される
// - 「メンバー同期」で POST members/sync が打たれる
// - 全会一致結果セクションが描画される
// - 「全員に配布」で POST whitelist/distribute が打たれる (Bot DM 配布)
// - 各メンバーの「DMで送信」で POST members/:id/send が打たれる
// - token は API レスポンスにも画面にも一切出ない (プライバシー穴の封鎖)

const EVENT_ID = "ev1";
const ACTION_ID = "act-wl";

type FetchCall = { url: string; method: string };

const MEMBERS = [
  { id: "m1", displayName: "山田 太郎", submitted: true, submittedAt: "2026-05-20T09:30:00Z" },
  { id: "m2", displayName: "鈴木 花子", submitted: false, submittedAt: null },
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
      if (url.includes("/whitelist/distribute")) return json({ sent: members.length, failed: 0, total: members.length });
      if (url.endsWith("/send")) return json({ sent: 1, failed: 0, total: 1 });
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

  it("「全員に配布」で POST whitelist/distribute が打たれる (Bot DM 配布)", async () => {
    const calls = installFetchSpy();
    const user = userEvent.setup();
    render(<WhitelistAdminTab eventId={EVENT_ID} actionId={ACTION_ID} />);
    await screen.findByText("山田 太郎");
    await user.click(screen.getByRole("button", { name: "全員に配布" }));
    await waitFor(() => {
      const post = calls.find(
        (c) => c.method === "POST" && c.url.includes("/whitelist/distribute"),
      );
      expect(post).toBeDefined();
    });
    // 配布結果が通知される。
    expect(await screen.findByText(/2人にDMで配布しました/)).toBeInTheDocument();
  });

  it("各メンバーの「DMで送信」で POST members/:id/send が打たれる", async () => {
    const calls = installFetchSpy();
    const user = userEvent.setup();
    render(<WhitelistAdminTab eventId={EVENT_ID} actionId={ACTION_ID} />);
    await screen.findByText("山田 太郎");
    await user.click(
      screen.getByRole("button", { name: "山田 太郎 にDMで送信" }),
    );
    await waitFor(() => {
      const post = calls.find(
        (c) =>
          c.method === "POST" &&
          c.url.includes("/whitelist/members/m1/send"),
      );
      expect(post).toBeDefined();
    });
  });
});
