import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RoleMembersTab } from "../src/components/role-management/RoleMembersTab";
import type { EventAction } from "../src/types";
import { ToastProvider } from "../src/components/ui/Toast";
import { ConfirmProvider } from "../src/components/ui/ConfirmDialog";

// メンバー削除 (このイベントの全ロールから外す) の回帰。
// 確認ダイアログ -> DELETE members/:id -> 一覧のロールが「(ロールなし)」になる。

const EVENT_ID = "ev1";
const ACTION_ID = "act-role";

function makeAction(): EventAction {
  return {
    id: ACTION_ID,
    eventId: EVENT_ID,
    actionType: "role_management",
    config: JSON.stringify({ workspaceId: "ws1" }),
    enabled: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

const USERS = [
  { id: "U1", name: "alice", realName: "Alice A", displayName: "Alice" },
  { id: "U2", name: "bob", realName: "Bob B", displayName: "Bob" },
];
const ROLES = [
  {
    id: "r-staff",
    name: "運営",
    description: null,
    parentRoleId: null,
    membersCount: 1,
    channelsCount: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
];

type Call = { url: string; method: string };

function installFetch(): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : (input as Request).url ?? String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      const path = url.split("?")[0];
      const json = (v: unknown) =>
        new Response(JSON.stringify(v), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      if (path.endsWith("/workspace-members")) return json(USERS);
      // メンバー全解除 DELETE
      if (/\/actions\/[^/]+\/members\/[^/]+$/.test(path) && method === "DELETE")
        return json({ ok: true, removed: 1 });
      // 運営ロールに U1 が居る
      const m = path.match(/\/roles\/([^/]+)\/members$/);
      if (m && method === "GET")
        return json(m[1] === "r-staff" ? [{ slackUserId: "U1", addedAt: "x" }] : []);
      if (path.endsWith("/roles")) return json(ROLES);
      return json([]);
    }),
  );
  return calls;
}

function renderTab() {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <RoleMembersTab eventId={EVENT_ID} action={makeAction()} />
      </ConfirmProvider>
    </ToastProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("RoleMembersTab メンバー削除", () => {
  it("確認 -> DELETE -> 一覧のロールが(ロールなし)になる", async () => {
    const calls = installFetch();
    renderTab();

    // U1 に削除ボタンが出る (ロール保有者のみ)。U2 は非表示。
    const delBtn = await screen.findByTestId("remove-member-U1");
    expect(screen.queryByTestId("remove-member-U2")).toBeNull();

    await userEvent.click(delBtn);
    // 確認ダイアログを承認。
    await userEvent.click(
      await screen.findByRole("button", { name: "ロールから外す" }),
    );

    // DELETE が呼ばれた。
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === "DELETE" && /\/members\/U1$/.test(c.url.split("?")[0]),
        ),
      ).toBe(true),
    );
    // 一覧から削除ボタンが消え「(ロールなし)」になる。
    await waitFor(() =>
      expect(screen.queryByTestId("remove-member-U1")).toBeNull(),
    );
    // U1 も U2 も「(ロールなし)」表示になる (U1 は削除で、U2 は元々)。
    expect(screen.getAllByText("(ロールなし)").length).toBe(2);
  });
});
