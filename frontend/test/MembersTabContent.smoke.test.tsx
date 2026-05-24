import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MembersTabContent } from "../src/pages/MembersTabContent";
import type { EventAction } from "../src/types";
import { AppProviders } from "./util";

// members-tab-integration (2026-05) スモーク:
//   - actions 配列に member_roster / role_management が無いとき、
//     マウント時に POST /orgs/:eventId/actions を 2 回発火させる。
//   - actions が揃っている状態では POST を発火せず、サブタブの切替で
//     名簿 / ロール のラベルが切り替わる。
//
// 既存スモークの POST 検査パターン (RosterColumnsModal) を踏襲。

const EVENT_ID = "ev-1";

function makeAction(actionType: EventAction["actionType"]): EventAction {
  return {
    id: `act-${actionType}`,
    eventId: EVENT_ID,
    actionType,
    config: "{}",
    enabled: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

type Call = { url: string; method: string; body?: string };
let calls: Call[];

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" ? init.body : undefined;
      calls.push({ url, method, body });
      // POST は作成された action の素朴な mock。GET は空配列。
      const payload =
        method === "POST"
          ? { ...makeAction("member_roster"), id: "act-new" }
          : [];
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});

function mount(actions: EventAction[]) {
  const onActionsChange = vi.fn();
  render(
    <AppProviders>
      <MembersTabContent
        eventId={EVENT_ID}
        actions={actions}
        onActionsChange={onActionsChange}
      />
    </AppProviders>,
  );
  return { onActionsChange };
}

describe("MembersTabContent smoke (members-tab-integration)", () => {
  it("actions が空のとき、member_roster と role_management の POST が両方発火する", async () => {
    const { onActionsChange } = mount([]);
    // 初期は「初期化中...」が見える
    expect(screen.getByText(/初期化中/)).toBeInTheDocument();
    await waitFor(() => {
      const posts = calls.filter(
        (c) =>
          c.method === "POST" &&
          c.url.endsWith(`/orgs/${EVENT_ID}/actions`),
      );
      expect(posts.length).toBe(2);
      // body に actionType がそれぞれ含まれる
      expect(posts.some((p) => p.body?.includes("member_roster"))).toBe(true);
      expect(posts.some((p) => p.body?.includes("role_management"))).toBe(
        true,
      );
    });
    // 親に refetch を依頼している
    expect(onActionsChange).toHaveBeenCalled();
  });

  it("rosterAction だけ既存なら、role_management のみ POST する", async () => {
    mount([makeAction("member_roster")]);
    await waitFor(() => {
      const posts = calls.filter(
        (c) =>
          c.method === "POST" &&
          c.url.endsWith(`/orgs/${EVENT_ID}/actions`),
      );
      expect(posts.length).toBe(1);
      expect(posts[0].body?.includes("role_management")).toBe(true);
    });
  });

  it("両方揃っているとき、POST は発火せず サブタブの切替が動く", async () => {
    mount([makeAction("member_roster"), makeAction("role_management")]);
    // ロード解除を待つ (RosterPage が render される)
    await waitFor(() => {
      expect(screen.queryByText(/初期化中/)).toBeNull();
    });
    // 起動直後は POST 0 件
    expect(calls.filter((c) => c.method === "POST").length).toBe(0);

    // サブタブ「名簿」「ロール」が描画されている
    const rosterTab = screen.getByRole("button", { name: "名簿" });
    const roleTab = screen.getByRole("button", { name: "ロール" });
    expect(rosterTab).toBeInTheDocument();
    expect(roleTab).toBeInTheDocument();

    // ロールタブをクリック → 「ロール一覧サマリ」(RoleMainTab) が出る
    await userEvent.click(roleTab);
    await waitFor(() => {
      expect(screen.getByText("ロール一覧サマリ")).toBeInTheDocument();
    });
  });
});
