import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  PRReviewCard,
  type PRReviewWithLgtm,
  type StaleNudgeTarget,
} from "../src/components/pr-review/PRReviewCard";
import { ToastProvider } from "../src/components/ui/Toast";
import { ConfirmProvider } from "../src/components/ui/ConfirmDialog";

// PRReviewListTab stale-pr-nudge ボタンのスモークテスト。
// - nudgeTarget.kind="single" → 「リマインド送信」ボタンを描画し、クリックで
//   POST /orgs/:eventId/actions/:actionId/stale-pr-nudge/send を叩く
// - kind="none" → ボタンを出さない (対象 action なし)
// - kind="ambiguous" → ボタンを無効化する (複数あり安全に特定できない)

const EVENT_ID = "ev1";
const NUDGE_ACTION_ID = "act-stale-pr";

const REVIEW: PRReviewWithLgtm = {
  id: "pr1",
  eventId: EVENT_ID,
  title: "テスト PR",
  url: null,
  description: null,
  status: "open",
  requesterSlackId: "U123",
  reviewerSlackId: null,
  reviewRound: 1,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  lgtmCount: 0,
  reviewers: [],
  lgtms: [],
};

type FetchCall = { url: string; method: string; body?: string };

function installFetchSpy(opts?: { sendBody?: object }): FetchCall[] {
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
      if (url.includes("/stale-pr-nudge/send")) {
        return new Response(JSON.stringify(opts?.sendBody ?? { ok: true, nudged: 2 }), {
          status: 200,
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

function renderCard(
  nudgeTarget: StaleNudgeTarget,
  opts?: Parameters<typeof installFetchSpy>[0],
) {
  const calls = installFetchSpy(opts);
  render(
    <ConfirmProvider>
      <ToastProvider>
        <PRReviewCard
          review={REVIEW}
          lgtmThreshold={2}
          onSelect={() => {}}
          eventId={EVENT_ID}
          nudgeTarget={nudgeTarget}
        />
      </ToastProvider>
    </ConfirmProvider>,
  );
  return { calls };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PRReviewCard stale-pr-nudge ボタン", () => {
  it("kind=single でボタンを描画し、クリックで send endpoint を叩く", async () => {
    const user = userEvent.setup();
    const { calls } = renderCard({ kind: "single", actionId: NUDGE_ACTION_ID });
    const btn = screen.getByRole("button", { name: "📣 リマインド送信" });
    expect(btn).toBeEnabled();
    await user.click(btn);
    await waitFor(() => {
      const post = calls.find(
        (c) =>
          c.method === "POST" &&
          c.url.includes(
            `/orgs/${EVENT_ID}/actions/${NUDGE_ACTION_ID}/stale-pr-nudge/send`,
          ),
      );
      expect(post).toBeDefined();
    });
  });

  it("kind=none ではボタンを出さない", () => {
    renderCard({ kind: "none" });
    expect(
      screen.queryByRole("button", { name: "📣 リマインド送信" }),
    ).not.toBeInTheDocument();
  });

  it("kind=ambiguous ではボタンを無効化する", () => {
    renderCard({ kind: "ambiguous", count: 2 });
    const btn = screen.getByRole("button", { name: "📣 リマインド送信" });
    expect(btn).toBeDisabled();
  });

  it("再レビュー依頼ボタンは引き続き描画される (既存挙動を壊さない)", () => {
    renderCard({ kind: "single", actionId: NUDGE_ACTION_ID });
    expect(
      screen.getByRole("button", { name: "🔄 再レビュー依頼" }),
    ).toBeInTheDocument();
  });
});
