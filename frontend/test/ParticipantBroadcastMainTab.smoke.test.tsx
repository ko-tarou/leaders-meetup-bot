import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ParticipantBroadcastMainTab } from "../src/components/participant-broadcast/ParticipantBroadcastMainTab";
import type { EventAction } from "../src/types";
import { ToastProvider } from "../src/components/ui/Toast";

// participant_broadcast メインタブのスモークテスト。
// - プレビュー結果 (宛先数) を描画する
// - confirm チェックを付けるまで送信ボタンは押せない (誤爆ゲート)
// - 送信は confirm=true 付きで send endpoint へ POST する

const EVENT_ID = "ev1";
const ACTION_ID = "act-bc";

function makeAction(config: object): EventAction {
  return {
    id: ACTION_ID,
    eventId: EVENT_ID,
    actionType: "participant_broadcast",
    config: JSON.stringify(config),
    enabled: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

type FetchCall = { url: string; method: string; body?: string };

function installFetchSpy(): FetchCall[] {
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

      const json = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { "Content-Type": "application/json" },
        });

      if (url.includes("/gmail-accounts")) {
        return json([
          { id: "g1", email: "haccckit@gmail.com", createdAt: "", updatedAt: "" },
        ]);
      }
      if (url.includes("/participant-broadcast/preview")) {
        return json({
          recipientCount: 2,
          invalidLines: [],
          duplicateCount: 0,
          alreadySentCount: 0,
          sample: { to: "a@example.com", subject: "件名 A", body: "本文 A" },
          emails: ["a@example.com", "b@example.com"],
        });
      }
      if (url.includes("/participant-broadcast/send")) {
        return json({
          batchId: "batch1",
          attempted: 2,
          sent: 2,
          failed: 0,
          failures: [],
        });
      }
      if (url.includes("/participant-broadcast/logs")) {
        return json([]);
      }
      return json({ ok: true });
    }),
  );
  return calls;
}

function renderTab(action: EventAction) {
  const calls = installFetchSpy();
  render(
    <ToastProvider>
      <ParticipantBroadcastMainTab
        eventId={EVENT_ID}
        action={action}
        onChanged={() => {}}
      />
    </ToastProvider>,
  );
  return { calls };
}

const CONFIG = {
  gmailAccountId: "g1",
  recipientsText: "a@example.com\nb@example.com",
  subject: "件名 {name}",
  body: "本文 {name}",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ParticipantBroadcastMainTab smoke", () => {
  it("プレビューで宛先数を表示し、confirm 前は送信ボタンが無効", async () => {
    const user = userEvent.setup();
    renderTab(makeAction(CONFIG));

    await user.click(screen.getByRole("button", { name: /プレビュー/ }));

    await waitFor(() => {
      expect(screen.getByText(/送信対象: 2 件/)).toBeInTheDocument();
    });

    const sendBtn = screen.getByRole("button", { name: /一斉送信/ });
    expect(sendBtn).toBeDisabled();
  });

  it("confirm を付けると送信でき、confirm=true 付きで POST する", async () => {
    const user = userEvent.setup();
    const { calls } = renderTab(makeAction(CONFIG));

    await user.click(screen.getByRole("button", { name: /プレビュー/ }));
    await waitFor(() => screen.getByText(/送信対象: 2 件/));

    // confirm チェック
    await user.click(
      screen.getByRole("checkbox", { name: /この件名・本文で送信する/ }),
    );

    const sendBtn = screen.getByRole("button", { name: /一斉送信/ });
    expect(sendBtn).toBeEnabled();
    await user.click(sendBtn);

    await waitFor(() => {
      const post = calls.find(
        (c) =>
          c.method === "POST" &&
          c.url.includes(
            `/orgs/${EVENT_ID}/actions/${ACTION_ID}/participant-broadcast/send`,
          ),
      );
      expect(post).toBeDefined();
      const parsed = JSON.parse(post!.body!);
      expect(parsed.confirm).toBe(true);
      expect(parsed.gmailAccountId).toBe("g1");
    });
  });
});
