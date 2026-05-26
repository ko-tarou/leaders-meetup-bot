import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { RoleNameDisplay } from "../src/components/role-management/RoleNameDisplay";

// 003 PR8 → PR11: RoleNameDisplay は config.roleId だけからロール名を表示する。
// PR11 で ID 表示を全廃 (ユーザーには UUID は無意味なため)。
// observer:
//   - roleId 未指定 → "未設定"
//   - 取得成功 → name のみ (ID は表示しない)
//   - 取得失敗 (404 or null) → 警告 UI ("ロール取得失敗", ID は表示しない)

function stubFetch(handler: (url: string) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      return handler(url);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("RoleNameDisplay (003 PR8)", () => {
  it("roleId 未指定 → 「未設定」", () => {
    stubFetch(() => new Response("{}", { status: 200 }));
    render(<RoleNameDisplay roleId={null} />);
    expect(screen.getByText("未設定")).toBeInTheDocument();
  });

  it("空文字 roleId → 「未設定」 + fetch しない", () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    render(<RoleNameDisplay roleId="" />);
    expect(screen.getByText("未設定")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("取得成功 → name のみ表示 (ID は出さない)", async () => {
    stubFetch((url) => {
      if (url.includes("/api/roles/role-1")) {
        return new Response(
          JSON.stringify({
            id: "role-1",
            name: "勉強会チーム",
            eventActionId: "act-x",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
    render(<RoleNameDisplay roleId="role-1" />);
    await waitFor(() => {
      expect(screen.getByText("勉強会チーム")).toBeInTheDocument();
    });
    // PR11: ID は表示しない
    expect(screen.queryByText(/ID:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/role-1/)).not.toBeInTheDocument();
  });

  it("取得失敗 (404) → 警告 UI (ID は出さない)", async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: "role not found" }), {
          status: 404,
        }),
    );
    render(<RoleNameDisplay roleId="role-gone" />);
    await waitFor(() => {
      expect(screen.getByLabelText("ロール名取得失敗")).toBeInTheDocument();
    });
    // PR11: ID は表示しない
    expect(screen.queryByText(/role-gone/)).not.toBeInTheDocument();
    expect(screen.getByText("ロール取得失敗")).toBeInTheDocument();
  });

  it("network error → 警告 UI", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    render(<RoleNameDisplay roleId="role-x" />);
    await waitFor(() => {
      expect(screen.getByLabelText("ロール名取得失敗")).toBeInTheDocument();
    });
  });
});
