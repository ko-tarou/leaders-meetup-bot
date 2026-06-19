import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KejimeAdminTab } from "../src/components/kejime/KejimeAdminTab";

// 003 朝勉強会けじめ制度 PR15: KejimeAdminTab に追加したポイント直接編集 UI の smoke。
// - 各メンバー行に「編集」ボタンが出る
// - 編集 → input → 保存で POST /edit-points が打たれる
// - キャンセルで送信されない
// - 0 以上の整数のみ許可 (aria-invalid)

const EVENT_ID = "ev1";
const ACTION_ID = "act-kejime";

type FetchCall = { url: string; method: string; body?: string };

function installFetchSpy(opts?: {
  members?: Array<{
    id: string; displayName: string; slackUserId: string;
    currentPoints: number; ramenCount: number; displayPoints: number;
  }>;
}): FetchCall[] {
  const calls: FetchCall[] = [];
  const members = opts?.members ?? [
    {
      id: "m1", displayName: "山田", slackUserId: "U1",
      currentPoints: 3, ramenCount: 0, displayPoints: 3,
    },
    {
      id: "m2", displayName: "鈴木", slackUserId: "U2",
      currentPoints: 0, ramenCount: 0, displayPoints: 0,
    },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      const body = init?.body == null ? undefined : String(init.body);
      calls.push({ url, method, body });
      if (url.includes("/kejime/members")) {
        return new Response(JSON.stringify(members), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/kejime/events")) {
        return new Response(JSON.stringify([]), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/kejime/articles")) {
        return new Response(JSON.stringify([]), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/kejime/penalties")) {
        return new Response(JSON.stringify([]), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/kejime/edit-points")) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 201, headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("KejimeAdminTab edit-points smoke (PR15)", () => {
  it("メンバー行に「編集」ボタンが出る", async () => {
    installFetchSpy();
    render(<KejimeAdminTab eventId={EVENT_ID} actionId={ACTION_ID} />);
    const btns = await screen.findAllByRole("button", { name: /のポイントを編集$/ });
    expect(btns).toHaveLength(2);
  });

  it("編集 → 値を変えて保存 → POST /edit-points が呼ばれる", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const calls = installFetchSpy();
    const user = userEvent.setup();
    render(<KejimeAdminTab eventId={EVENT_ID} actionId={ACTION_ID} />);
    const editBtn = (await screen.findAllByRole("button", { name: /山田 のポイントを編集$/ }))[0];
    await user.click(editBtn);
    const input = await screen.findByLabelText("山田 の新しいポイント");
    await user.clear(input);
    await user.type(input, "10");
    await user.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url.includes("/edit-points"));
      expect(post).toBeDefined();
      const body = JSON.parse(post!.body!);
      expect(body.memberId).toBe("m1");
      expect(body.newPoints).toBe(10);
    });
  });

  it("キャンセルで POST が打たれない", async () => {
    const calls = installFetchSpy();
    const user = userEvent.setup();
    render(<KejimeAdminTab eventId={EVENT_ID} actionId={ACTION_ID} />);
    const editBtn = (await screen.findAllByRole("button", { name: /山田 のポイントを編集$/ }))[0];
    await user.click(editBtn);
    await user.click(screen.getByRole("button", { name: /キャンセル/ }));
    expect(calls.filter((c) => c.method === "POST" && c.url.includes("/edit-points"))).toHaveLength(0);
  });

  it("負数 → aria-invalid + 保存ボタン無効", async () => {
    installFetchSpy();
    const user = userEvent.setup();
    render(<KejimeAdminTab eventId={EVENT_ID} actionId={ACTION_ID} />);
    const editBtn = (await screen.findAllByRole("button", { name: /山田 のポイントを編集$/ }))[0];
    await user.click(editBtn);
    const input = await screen.findByLabelText("山田 の新しいポイント");
    await user.clear(input);
    await user.type(input, "-3");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: /保存/ })).toBeDisabled();
  });
});
