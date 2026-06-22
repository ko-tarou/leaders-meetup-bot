import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MorningStandupMainTab } from "../src/components/morning-standup/MorningStandupMainTab";
import type { EventAction } from "../src/types";

// 003 PR10: morning_standup メインタブ (出席ダッシュボード) の smoke。
// - 当日 GET / stats GET をレンダリング
// - 「出席にする」「取り消し」ボタンが POST / DELETE を打つ
// - 出席率テーブルが render される

const EVENT_ID = "ev1";
const ACTION_ID = "act-morning";

function makeAction(): EventAction {
  return {
    id: ACTION_ID,
    eventId: EVENT_ID,
    actionType: "morning_standup",
    config: JSON.stringify({ schemaVersion: 1, channelId: "C1", roleId: "r1" }),
    enabled: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

type FetchCall = { url: string; method: string; body?: string };

type DayMember = {
  slackUserId: string; displayName: string;
  status: "attended" | "late" | null; attendanceId?: string;
};

function installFetchSpy(opts?: {
  dayMembers?: DayMember[];
  statsMembers?: Array<{
    slackUserId: string; displayName: string;
    attendedCount: number; lateCount: number; attendanceRate: number;
  }>;
}): FetchCall[] {
  const calls: FetchCall[] = [];
  const dayMembers: DayMember[] = opts?.dayMembers ?? [
    { slackUserId: "U1", displayName: "山田太郎", status: "attended", attendanceId: "ma-1" },
    { slackUserId: "U2", displayName: "鈴木次郎", status: "late" },
    { slackUserId: "U3", displayName: "佐藤三郎", status: null },
  ];
  const statsMembers = opts?.statsMembers ?? [
    { slackUserId: "U1", displayName: "山田太郎", attendedCount: 4, lateCount: 1, attendanceRate: 80 },
    { slackUserId: "U2", displayName: "鈴木次郎", attendedCount: 1, lateCount: 4, attendanceRate: 20 },
  ];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      const body = init?.body == null ? undefined : String(init.body);
      calls.push({ url, method, body });

      // 回 (session) スケジュール GET は配列を返す (Feature ①)。
      if (url.includes("/morning-attendance/sessions") && method === "GET") {
        return new Response(JSON.stringify([]), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/morning-attendance/stats")) {
        return new Response(
          JSON.stringify({ from: "2026-05-13", to: "2026-05-19", days: 7, members: statsMembers }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/morning-attendance") && method === "GET") {
        return new Response(
          JSON.stringify({ date: "2026-05-19", members: dayMembers }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // POST attend or DELETE revoke → 201/200 ok を返す。
      return new Response(JSON.stringify({ ok: true }), {
        status: method === "POST" ? 201 : 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MorningStandupMainTab smoke", () => {
  it("当日メンバーの 3 件 (attended/late/null) が render される", async () => {
    installFetchSpy();
    render(
      <MorningStandupMainTab
        eventId={EVENT_ID} actionId={ACTION_ID} action={makeAction()}
      />,
    );
    // 山田太郎 は当日テーブル + stats テーブルの両方に出る (2 件以上)。
    await waitFor(() => {
      expect(screen.getAllByText("山田太郎").length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.getByText("佐藤三郎")).toBeInTheDocument(); // 当日のみ
    expect(screen.getByText("✅ 出席済")).toBeInTheDocument();
    expect(screen.getByText("❌ 未出席")).toBeInTheDocument();
    expect(screen.getByText("⏳ 判定前")).toBeInTheDocument();
  });

  it("出席済みメンバーには「取り消し」ボタン、未/判定前メンバーには「出席にする」ボタン", async () => {
    installFetchSpy();
    render(
      <MorningStandupMainTab
        eventId={EVENT_ID} actionId={ACTION_ID} action={makeAction()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText("山田太郎 の出席を取り消し")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("鈴木次郎 を出席にする")).toBeInTheDocument();
    expect(screen.getByLabelText("佐藤三郎 を出席にする")).toBeInTheDocument();
  });

  it("「出席にする」クリック → POST が呼ばれる", async () => {
    const user = userEvent.setup();
    const calls = installFetchSpy();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <MorningStandupMainTab
        eventId={EVENT_ID} actionId={ACTION_ID} action={makeAction()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText("鈴木次郎 を出席にする")).toBeInTheDocument();
    });
    await user.click(screen.getByLabelText("鈴木次郎 を出席にする"));
    await waitFor(() => {
      expect(calls.some((c) => c.method === "POST" && c.url.includes("/morning-attendance"))).toBe(true);
    });
    const post = calls.find((c) => c.method === "POST" && c.url.includes("/morning-attendance"))!;
    const parsed = JSON.parse(post.body!) as { slackUserId: string };
    expect(parsed.slackUserId).toBe("U2");
  });

  it("「取り消し」クリック → DELETE が呼ばれる", async () => {
    const user = userEvent.setup();
    const calls = installFetchSpy();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <MorningStandupMainTab
        eventId={EVENT_ID} actionId={ACTION_ID} action={makeAction()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText("山田太郎 の出席を取り消し")).toBeInTheDocument();
    });
    await user.click(screen.getByLabelText("山田太郎 の出席を取り消し"));
    await waitFor(() => {
      expect(calls.some((c) => c.method === "DELETE" && c.url.includes("/morning-attendance/ma-1"))).toBe(true);
    });
  });

  it("過去 7 日の出席率テーブルが表示される", async () => {
    installFetchSpy();
    render(
      <MorningStandupMainTab
        eventId={EVENT_ID} actionId={ACTION_ID} action={makeAction()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/過去 7 日の出席率/)).toBeInTheDocument();
    });
    expect(screen.getByText("80%")).toBeInTheDocument();
    expect(screen.getByText("20%")).toBeInTheDocument();
  });

  it("confirm を cancel すれば POST は呼ばれない", async () => {
    const user = userEvent.setup();
    const calls = installFetchSpy();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <MorningStandupMainTab
        eventId={EVENT_ID} actionId={ACTION_ID} action={makeAction()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText("鈴木次郎 を出席にする")).toBeInTheDocument();
    });
    const baseCallCount = calls.length;
    await user.click(screen.getByLabelText("鈴木次郎 を出席にする"));
    // 操作後にも fetch は増えない (確認キャンセル)。
    expect(calls.length).toBe(baseCallCount);
  });

  it("ロール未設定 (members 0) → 空状態 CTA が表示される (ID 表記なし)", async () => {
    installFetchSpy({ dayMembers: [] });
    render(
      <MorningStandupMainTab
        eventId={EVENT_ID} actionId={ACTION_ID} action={makeAction()}
      />,
    );
    await waitFor(() => {
      // PR11: 「roleId」等の技術用語を出さず、自然言語で案内する。
      expect(screen.getByText(/ロール未設定またはメンバーが 0 名/)).toBeInTheDocument();
      expect(screen.getByText(/勉強会チーム/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/roleId/)).not.toBeInTheDocument();
  });
});
