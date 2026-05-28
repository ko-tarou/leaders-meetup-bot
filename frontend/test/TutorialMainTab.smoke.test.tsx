import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TutorialMainTab } from "../src/components/tutorial/TutorialMainTab";
import type { EventAction } from "../src/types";
import { ToastProvider } from "../src/components/ui/Toast";

// 宗教イベント tutorial PR2: メインタブのスモークテスト。
// - 設定サマリ (トリガーチャンネル NAME / 送信方法) を描画する (生 ID は出さない)
// - ユーザーを選び「このユーザーに送信」で { userId } を send endpoint へ POST
// - workspaceId 未設定なら設定を促す案内を出す

const EVENT_ID = "ev1";
const ACTION_ID = "act-tut";

function makeAction(config: object): EventAction {
  return {
    id: ACTION_ID,
    eventId: EVENT_ID,
    actionType: "tutorial",
    config: JSON.stringify(config),
    enabled: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

type FetchCall = { url: string; method: string; body?: string };

function installFetchSpy(opts?: {
  members?: { id: string; name: string; realName?: string; displayName?: string }[];
  channels?: { id: string; name: string }[];
  sendStatus?: number;
  sendBody?: object;
}): FetchCall[] {
  const calls: FetchCall[] = [];
  const members = opts?.members ?? [
    { id: "U1", name: "taro", realName: "山田太郎" },
    { id: "U2", name: "hanako", realName: "鈴木花子" },
  ];
  const channels = opts?.channels ?? [{ id: "C0TRIG", name: "welcome" }];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = init?.method ?? "GET";
      const body = init?.body == null ? undefined : String(init.body);
      calls.push({ url, method, body });

      const json = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { "Content-Type": "application/json" },
        });

      if (url.includes("/tutorial/send")) {
        return json(opts?.sendBody ?? { ok: true }, opts?.sendStatus ?? 200);
      }
      if (url.includes("/members")) {
        return json(members);
      }
      if (url.includes("/api/slack/channels")) {
        return json(channels);
      }
      return json({ ok: true });
    }),
  );
  return calls;
}

function renderTab(action: EventAction, opts?: Parameters<typeof installFetchSpy>[0]) {
  const calls = installFetchSpy(opts);
  render(
    <ToastProvider>
      <TutorialMainTab eventId={EVENT_ID} actionId={ACTION_ID} action={action} />
    </ToastProvider>,
  );
  return { calls };
}

const CONFIGURED = {
  schemaVersion: 1,
  workspaceId: "ws1",
  triggerChannelId: "C0TRIG",
  deliveryMode: "dm",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TutorialMainTab smoke (宗教 PR2)", () => {
  it("設定サマリとユーザーピッカー + 送信ボタンを描画する (生 ID は出さない)", async () => {
    renderTab(makeAction(CONFIGURED));
    expect(
      await screen.findByRole("option", { name: "山田太郎" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("送信先ユーザー")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /このユーザーに送信/ }),
    ).toBeInTheDocument();
    // 生の user / channel ID は表示しない
    expect(screen.queryByText("U1")).not.toBeInTheDocument();
    expect(screen.queryByText("C0TRIG")).not.toBeInTheDocument();
  });

  it("トリガーチャンネルを NAME で表示する", async () => {
    renderTab(makeAction(CONFIGURED));
    expect(await screen.findByText("#welcome")).toBeInTheDocument();
  });

  it("ユーザーを選び送信すると { userId } を send endpoint へ POST", async () => {
    const user = userEvent.setup();
    const { calls } = renderTab(makeAction(CONFIGURED));
    await screen.findByRole("option", { name: "山田太郎" });
    await user.selectOptions(screen.getByLabelText("送信先ユーザー"), "U1");
    await user.click(screen.getByRole("button", { name: /このユーザーに送信/ }));
    await waitFor(() => {
      const post = calls.find(
        (c) =>
          c.method === "POST" &&
          c.url.includes(`/orgs/${EVENT_ID}/actions/${ACTION_ID}/tutorial/send`),
      );
      expect(post).toBeDefined();
      expect(JSON.parse(post!.body!)).toEqual({ userId: "U1" });
    });
  });

  it("workspaceId 未設定なら設定を促す案内を出す", () => {
    const { calls } = renderTab(makeAction({}));
    expect(screen.getByText(/未設定です/)).toBeInTheDocument();
    // members fetch も呼ばれない
    expect(calls.some((c) => c.url.includes("/members"))).toBe(false);
  });
});
