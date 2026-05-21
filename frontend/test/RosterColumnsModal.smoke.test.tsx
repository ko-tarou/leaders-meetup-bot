import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RosterColumnsModal } from "../src/pages/roster/RosterColumnsModal";
import type { RosterCustomColumn } from "../src/types";
import { AppProviders } from "./util";

// 名簿管理 PR5-FE: RosterColumnsModal の smoke。
// 列一覧表示 / 追加 (POST) / 削除 (confirm → DELETE) / 閉じる の主要動線を覆う。
const ACTION_ID = "act-1";
const cols: RosterCustomColumn[] = [
  { id: "c-1", eventActionId: ACTION_ID, columnKey: "position", label: "役職",
    type: "text", optionsJson: null, sortOrder: 0,
    createdAt: "2025-04-01T00:00:00Z", updatedAt: "2025-04-01T00:00:00Z" },
  { id: "c-2", eventActionId: ACTION_ID, columnKey: "size", label: "サイズ",
    type: "select", optionsJson: JSON.stringify(["S", "M", "L"]), sortOrder: 10,
    createdAt: "2025-04-01T00:00:00Z", updatedAt: "2025-04-01T00:00:00Z" },
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
    const payload = method === "GET" ? cols
      : method === "POST" ? { ...cols[0], id: "c-new" } : { ok: true };
    return new Response(JSON.stringify(payload),
      { status: 200, headers: { "Content-Type": "application/json" } });
  }));
});

function mount() {
  const onClose = vi.fn();
  render(<AppProviders>
    <RosterColumnsModal actionId={ACTION_ID} onClose={onClose} />
  </AppProviders>);
  return { onClose };
}

describe("RosterColumnsModal smoke", () => {
  it("既存列のラベル/型/select 選択肢が表示される", async () => {
    mount();
    expect(await screen.findByText("役職")).toBeInTheDocument();
    expect(screen.getByText("サイズ")).toBeInTheDocument();
    expect(screen.getByText(/S, M, L/)).toBeInTheDocument();
  });

  it("列追加フォーム入力 → POST が発火する", async () => {
    mount();
    await screen.findByText("役職");
    await userEvent.type(screen.getByLabelText("新しい列のキー"), "phone");
    await userEvent.type(screen.getByLabelText("新しい列のラベル"), "電話番号");
    await userEvent.click(screen.getByRole("button", { name: /列を追加/ }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === "POST"
        && c.url.endsWith(`/event-actions/${ACTION_ID}/roster/columns`)
        && c.body?.includes("phone") && c.body?.includes("電話番号"))).toBe(true);
    });
  });

  it("削除ボタン → confirm 承認 → DELETE が発火する", async () => {
    mount();
    await screen.findByText("役職");
    await userEvent.click(screen.getByRole("button", { name: "役職 を削除" }));
    const okBtn = await screen.findByRole("button", { name: "削除する" });
    await userEvent.click(okBtn);
    await waitFor(() => {
      expect(calls.some((c) => c.method === "DELETE"
        && c.url.endsWith("/roster/columns/c-1"))).toBe(true);
    });
  });

  it("編集ボタン → ラベル変更 → 保存で PUT が発火する (PR5b)", async () => {
    mount();
    await screen.findByText("役職");
    await userEvent.click(screen.getByRole("button", { name: "役職 を編集" }));
    const labelInput = await screen.findByLabelText("役職 のラベル");
    await userEvent.clear(labelInput);
    await userEvent.type(labelInput, "新役職");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === "PUT"
        && c.url.endsWith(`/event-actions/${ACTION_ID}/roster/columns/c-1`)
        && c.body?.includes("新役職"))).toBe(true);
    });
  });

  it("× ボタンで onClose 発火", async () => {
    const { onClose } = mount();
    await screen.findByText("役職");
    await userEvent.click(screen.getByLabelText("閉じる"));
    expect(onClose).toHaveBeenCalled();
  });
});
