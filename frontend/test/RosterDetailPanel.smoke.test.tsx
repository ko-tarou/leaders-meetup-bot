import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RosterDetailPanel } from "../src/pages/roster/RosterDetailPanel";
import type { RosterMember, SlackRole } from "../src/types";
import { AppProviders } from "./util";

// 名簿管理 PR4-FE: RosterDetailPanel (編集 / ロール選択 / 退会) の smoke。
const EVENT_ID = "ev-1", ACTION_ID = "act-1";
const member: RosterMember = {
  id: "m-1", eventActionId: ACTION_ID, name: "Alice", nameKana: "アリス",
  email: "alice@example.com", grade: "B3", slackUserId: "U1", slackName: "alice",
  joinedAt: "2025-04-01", leftAt: null, note: null, status: "active",
  createdAt: "2025-04-01T00:00:00Z", updatedAt: "2025-04-01T00:00:00Z", deletedAt: null,
};
const roles: SlackRole[] = [
  { id: "r-1", name: "tech-lead", description: null, parentRoleId: null,
    membersCount: 0, channelsCount: 0, createdAt: "x", updatedAt: "x" },
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
    const path = url.split("?")[0];
    let payload: unknown = {};
    if (path.endsWith(`/roster/members/${member.id}/roles`))
      payload = method === "GET" ? { roleIds: [] } : { ok: true, roleIds: [] };
    else if (path.endsWith(`/actions/${ACTION_ID}/roles`)) payload = roles;
    else if (path.endsWith(`/roster/members/${member.id}`))
      payload = { ...member, ...JSON.parse(body ?? "{}") };
    return new Response(JSON.stringify(payload),
      { status: 200, headers: { "Content-Type": "application/json" } });
  }));
});

function mount(extra?: Partial<Parameters<typeof RosterDetailPanel>[0]>) {
  const onClose = vi.fn(), onChanged = vi.fn();
  render(<AppProviders><RosterDetailPanel eventId={EVENT_ID} actionId={ACTION_ID}
    member={member} onClose={onClose} onChanged={onChanged} {...extra}/></AppProviders>);
  return { onClose, onChanged };
}

describe("RosterDetailPanel smoke", () => {
  it("タイトルとロール候補を表示し、閉じるボタンで onClose 発火", async () => {
    const { onClose } = mount();
    expect(screen.getAllByText("Alice").length).toBeGreaterThan(0);
    expect(await screen.findByLabelText(/tech-lead/)).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("閉じる"));
    expect(onClose).toHaveBeenCalled();
  });

  it("フィールドを編集して保存すると PUT /roster/members/:id が発火する", async () => {
    const { onChanged } = mount();
    const input = await screen.findByDisplayValue("Alice");
    await userEvent.clear(input);
    await userEvent.type(input, "Alicia");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === "PUT"
        && c.url.includes(`/roster/members/${member.id}`)
        && !c.url.endsWith("/roles")
        && c.body?.includes("Alicia"))).toBe(true);
    });
    expect(onChanged).toHaveBeenCalled();
  });

  it("ロールをチェックして保存すると PUT /roles が発火する", async () => {
    mount();
    await userEvent.click(await screen.findByLabelText(/tech-lead/));
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === "PUT"
        && c.url.endsWith(`/roster/members/${member.id}/roles`)
        && c.body?.includes("r-1"))).toBe(true);
    });
  });

  it("退会ボタン → 確認承認で DELETE が発火し onChanged(null)", async () => {
    const { onChanged } = mount();
    await userEvent.click(screen.getByRole("button", { name: "退会させる" }));
    // ConfirmDialog の確認ボタン (パネル内と同名なので最後にクリックされる方を取る)
    const buttons = await screen.findAllByRole("button", { name: "退会させる" });
    await userEvent.click(buttons[buttons.length - 1]!);
    await waitFor(() => {
      expect(calls.some((c) => c.method === "DELETE"
        && c.url.endsWith(`/roster/members/${member.id}`))).toBe(true);
    });
    expect(onChanged).toHaveBeenCalledWith(null);
  });
});
