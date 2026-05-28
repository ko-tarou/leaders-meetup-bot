import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GoalReminderMainTab } from "../src/components/goal-reminder/GoalReminderMainTab";
import type { EventAction } from "../src/types";
import { ToastProvider } from "../src/components/ui/Toast";

// 宗教イベント goal_reminder PR2: メインタブのスモークテスト。
// - 設定サマリ (目標 / 朝夜時刻 / 頻度) を描画する (生 ID は出さない)
// - 「朝を今すぐ送信」で { slot: "morning" } を send endpoint へ POST
// - 「夜を今すぐ送信」で { slot: "night" } を send endpoint へ POST
// - not_configured エラー時は分かりやすい案内を出す

const EVENT_ID = "ev1";
const ACTION_ID = "act-gr";

function makeAction(config: object): EventAction {
  return {
    id: ACTION_ID,
    eventId: EVENT_ID,
    actionType: "goal_reminder",
    config: JSON.stringify(config),
    enabled: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

type FetchCall = { url: string; method: string; body?: string };

function installFetchSpy(opts?: { sendStatus?: number; sendBody?: object }): FetchCall[] {
  const calls: FetchCall[] = [];
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

      if (url.includes("/goal-reminder/send")) {
        return new Response(JSON.stringify(opts?.sendBody ?? { ok: true }), {
          status: opts?.sendStatus ?? 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return calls;
}

function renderTab(action: EventAction, opts?: Parameters<typeof installFetchSpy>[0]) {
  const calls = installFetchSpy(opts);
  render(
    <ToastProvider>
      <GoalReminderMainTab eventId={EVENT_ID} actionId={ACTION_ID} action={action} />
    </ToastProvider>,
  );
  return { calls };
}

const CONFIGURED = {
  schemaVersion: 1,
  workspaceId: "ws1",
  channelId: "C0GOAL",
  morningTime: "08:00",
  nightTime: "22:00",
  frequency: "daily",
  goalText: "世界を変える",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GoalReminderMainTab smoke (宗教 PR2)", () => {
  it("設定サマリと 2 つの送信ボタンを描画する (生 ID は出さない)", () => {
    renderTab(makeAction(CONFIGURED));
    expect(screen.getByText("世界を変える")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /朝のメッセージを今すぐ送信/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /夜のメッセージを今すぐ送信/ }),
    ).toBeInTheDocument();
    // channelId は生で表示しない
    expect(screen.queryByText("C0GOAL")).not.toBeInTheDocument();
  });

  it("朝ボタンで { slot: 'morning' } を send endpoint へ POST", async () => {
    const user = userEvent.setup();
    const { calls } = renderTab(makeAction(CONFIGURED));
    await user.click(screen.getByRole("button", { name: /朝のメッセージを今すぐ送信/ }));
    await waitFor(() => {
      const post = calls.find(
        (c) =>
          c.method === "POST" &&
          c.url.includes(`/orgs/${EVENT_ID}/actions/${ACTION_ID}/goal-reminder/send`),
      );
      expect(post).toBeDefined();
      expect(JSON.parse(post!.body!)).toEqual({ slot: "morning" });
    });
  });

  it("夜ボタンで { slot: 'night' } を send endpoint へ POST", async () => {
    const user = userEvent.setup();
    const { calls } = renderTab(makeAction(CONFIGURED));
    await user.click(screen.getByRole("button", { name: /夜のメッセージを今すぐ送信/ }));
    await waitFor(() => {
      const post = calls.find(
        (c) => c.method === "POST" && c.url.includes("/goal-reminder/send"),
      );
      expect(post).toBeDefined();
      expect(JSON.parse(post!.body!)).toEqual({ slot: "night" });
    });
  });

  it("未設定 config では注意文を出す", () => {
    renderTab(makeAction({}));
    expect(screen.getByText(/未設定です/)).toBeInTheDocument();
  });
});
