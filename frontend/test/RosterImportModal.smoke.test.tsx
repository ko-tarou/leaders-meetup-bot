import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RosterImportModal } from "../src/pages/roster/RosterImportModal";
import type { RosterImportCandidate } from "../src/types";
import { AppProviders } from "./util";

// 名簿管理 PR6-FE: RosterImportModal の smoke。
// 候補一覧表示 / すべて選択 / 個別チェック → 一括 POST / モーダル close を覆う。
const EVENT_ID = "ev-1";
const ACTION_ID = "act-1";

const cands: RosterImportCandidate[] = [
  { id: "app-1", name: "Alice", email: "alice@example.com",
    decidedAt: "2025-04-01", slackName: "alice" },
  { id: "app-2", name: "Bob", email: "bob@example.com",
    decidedAt: "2025-04-02", slackName: null },
];

type Call = { url: string; method: string; body?: string };
let calls: Call[];

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input
      : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url, method, body });
    if (method === "GET" && url.includes("import-candidates")) {
      return new Response(JSON.stringify(cands),
        { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (method === "POST" && url.includes("/roster/members")) {
      const parsed = body ? JSON.parse(body) as { name: string } : { name: "x" };
      return new Response(JSON.stringify({ id: crypto.randomUUID(), name: parsed.name }),
        { status: 201, headers: { "Content-Type": "application/json" } });
    }
    return new Response("[]",
      { status: 200, headers: { "Content-Type": "application/json" } });
  }));
});

function mount() {
  const onClose = vi.fn();
  const onImported = vi.fn();
  render(<AppProviders>
    <RosterImportModal
      eventId={EVENT_ID} actionId={ACTION_ID}
      onClose={onClose} onImported={onImported} />
  </AppProviders>);
  return { onClose, onImported };
}

describe("RosterImportModal smoke", () => {
  it("候補一覧 (名前 / メール / 合格日) が表示される", async () => {
    mount();
    expect(await screen.findByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    expect(screen.getByText("2025-04-02")).toBeInTheDocument();
  });

  it("チェックして「選択を追加」で POST が選択数だけ発火する", async () => {
    const { onImported } = mount();
    await screen.findByText("Alice");
    await userEvent.click(screen.getByLabelText("Alice を選択"));
    await userEvent.click(screen.getByRole("button", { name: /選択を追加/ }));
    await waitFor(() => {
      const posts = calls.filter((c) => c.method === "POST"
        && c.url.includes("/roster/members"));
      expect(posts.length).toBe(1);
      expect(posts[0]!.body).toContain("Alice");
    });
    expect(onImported).toHaveBeenCalled();
  });

  it("「すべて選択」で全候補が選択され、押下で全件 POST される", async () => {
    mount();
    await screen.findByText("Alice");
    await userEvent.click(screen.getByLabelText("すべて選択"));
    await userEvent.click(screen.getByRole("button", { name: /選択を追加/ }));
    await waitFor(() => {
      const posts = calls.filter((c) => c.method === "POST"
        && c.url.includes("/roster/members"));
      expect(posts.length).toBe(2);
    });
  });

  it("候補ゼロ件の場合は空状態メッセージが出る", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response("[]", { status: 200,
        headers: { "Content-Type": "application/json" } })));
    render(<AppProviders>
      <RosterImportModal eventId={EVENT_ID} actionId={ACTION_ID}
        onClose={vi.fn()} onImported={vi.fn()} />
    </AppProviders>);
    await waitFor(() => {
      expect(screen.getByText(/取り込み可能な合格者はいません/)).toBeInTheDocument();
    });
  });

  it("× で onClose が発火する", async () => {
    const { onClose } = mount();
    await screen.findByText("Alice");
    await userEvent.click(screen.getByLabelText("閉じる"));
    expect(onClose).toHaveBeenCalled();
  });
});
