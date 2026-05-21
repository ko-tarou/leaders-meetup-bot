import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RosterMemberAddModal } from "../src/pages/roster/RosterMemberAddModal";
import { AppProviders } from "./util";

// 名簿管理 PR6-FE: RosterMemberAddModal の smoke。
// name 必須バリデーション / 入力 → POST / メール形式チェック を覆う。
const ACTION_ID = "act-1";

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
    if (method === "POST") {
      return new Response(JSON.stringify({ id: "new-1", name: "X" }),
        { status: 201, headers: { "Content-Type": "application/json" } });
    }
    return new Response("[]",
      { status: 200, headers: { "Content-Type": "application/json" } });
  }));
});

function mount() {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  render(<AppProviders>
    <RosterMemberAddModal actionId={ACTION_ID}
      onClose={onClose} onCreated={onCreated} />
  </AppProviders>);
  return { onClose, onCreated };
}

describe("RosterMemberAddModal smoke", () => {
  it("名前を入力 → 追加で POST が発火し onCreated が呼ばれる", async () => {
    const { onCreated, onClose } = mount();
    await userEvent.type(screen.getByLabelText("名前 *"), "新規 太郎");
    await userEvent.type(screen.getByLabelText("メール"), "taro@example.com");
    await userEvent.click(screen.getByRole("button", { name: "追加" }));
    await waitFor(() => {
      const posts = calls.filter((c) => c.method === "POST"
        && c.url.endsWith(`/event-actions/${ACTION_ID}/roster/members`));
      expect(posts.length).toBe(1);
      expect(posts[0]!.body).toContain("新規 太郎");
      expect(posts[0]!.body).toContain("taro@example.com");
    });
    expect(onCreated).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("名前未入力で追加押下 → POST されない", async () => {
    mount();
    await userEvent.click(screen.getByRole("button", { name: "追加" }));
    // toast error が出るだけで API は叩かれない
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("不正なメール形式で追加押下 → POST されない", async () => {
    mount();
    await userEvent.type(screen.getByLabelText("名前 *"), "X");
    await userEvent.type(screen.getByLabelText("メール"), "not-an-email");
    await userEvent.click(screen.getByRole("button", { name: "追加" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("× で onClose が発火する", async () => {
    const { onClose } = mount();
    await userEvent.click(screen.getByLabelText("閉じる"));
    expect(onClose).toHaveBeenCalled();
  });
});
