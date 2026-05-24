import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RosterImportModal } from "../src/pages/roster/RosterImportModal";
import type { RosterImportCandidate } from "../src/types";
import { AppProviders } from "./util";

// 名簿管理 RosterImportModal の smoke。
// PR3 (2026-05): 参加届ベース (participation_forms.submitted) に変更。
//   候補は { id, name, email, slackEmail, slackName, slackUserId, submittedAt } を持ち、
//   テーブルには 名前 / メール / Slack 名 / Slack ID を表示する。
const EVENT_ID = "ev-1";
const ACTION_ID = "act-1";

const cands: RosterImportCandidate[] = [
  {
    id: "pf-1", name: "Alice", email: "alice@example.com",
    slackEmail: "alice@slack.example.com",
    slackName: "alice", slackUserId: "U_ALICE",
    submittedAt: "2026-05-10T00:00:00.000Z",
  },
  {
    id: "pf-2", name: "Bob", email: "bob@example.com",
    slackEmail: null, slackName: null, slackUserId: null,
    submittedAt: "2026-05-09T00:00:00.000Z",
  },
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
  it("モーダルタイトルが「参加届を提出した人から取り込み」", async () => {
    mount();
    expect(
      await screen.findByRole("dialog", { name: /参加届を提出した人から取り込み/ }),
    ).toBeInTheDocument();
  });

  it("候補一覧 (名前 / メール / Slack 名 / Slack ID) が表示される", async () => {
    mount();
    expect(await screen.findByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    expect(screen.getByText("U_ALICE")).toBeInTheDocument();
    // Slack ID 未解決の Bob には「未解決」が表示される
    expect(screen.getByText("未解決")).toBeInTheDocument();
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

  // PR3 (2026-05): 取り込み時に Slack 情報 (slackEmail/slackName/slackUserId)
  // と joinedAt (= submittedAt) も POST body に渡されることを確認。
  it("Slack 情報も一緒に保存される (slackEmail/slackName/slackUserId/joinedAt)", async () => {
    mount();
    await screen.findByText("Alice");
    await userEvent.click(screen.getByLabelText("Alice を選択"));
    await userEvent.click(screen.getByRole("button", { name: /選択を追加/ }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST"
        && c.url.includes("/roster/members"));
      expect(post).toBeDefined();
      const body = JSON.parse(post!.body!) as Record<string, unknown>;
      expect(body).toMatchObject({
        name: "Alice",
        email: "alice@example.com",
        slackEmail: "alice@slack.example.com",
        slackName: "alice",
        slackUserId: "U_ALICE",
        joinedAt: "2026-05-10T00:00:00.000Z",
      });
    });
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
      expect(screen.getByText(/取り込み可能な参加届はありません/)).toBeInTheDocument();
    });
  });

  it("× で onClose が発火する", async () => {
    const { onClose } = mount();
    await screen.findByText("Alice");
    await userEvent.click(screen.getByLabelText("閉じる"));
    expect(onClose).toHaveBeenCalled();
  });

  // UX-PR3 (D): 下部「キャンセル」は右上 × と機能が被るため削除済み。
  // フッターには primary action (選択を追加) だけが残ることを担保する。
  it("下部に「キャンセル」ボタンは無い (右上 × に統一済み)", async () => {
    mount();
    await screen.findByText("Alice");
    expect(screen.queryByRole("button", { name: "キャンセル" })).toBeNull();
  });
});
