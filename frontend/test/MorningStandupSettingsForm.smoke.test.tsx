import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MorningStandupSettingsForm } from "../src/components/morning-standup/MorningStandupSettingsForm";
import type { EventAction } from "../src/types";
import { ToastProvider } from "../src/components/ui/Toast";

// 003 PR7 → PR8 → PR9: morning_standup 設定タブのスモークテスト。
// PR9 で ChannelSelector → SingleChannelPicker、reminderTime / closeTime 追加。
// observer:
//   - workspace 一覧 fetch + SingleChannelPicker で channel 選択できる
//   - reminderTime / closeTime のバリデーション
//   - 保存時 PUT body に reminderTime / closeTime が乗る
//   - messageTemplates 既存挙動 (空欄なら omit) は維持

const EVENT_ID = "ev1";

function makeAction(config: object): EventAction {
  return {
    id: "act-morning",
    eventId: EVENT_ID,
    actionType: "morning_standup",
    config: JSON.stringify(config),
    enabled: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

type FetchCall = { url: string; method: string; body?: string };

function installFetchSpy(opts?: {
  workspaces?: { id: string; name: string; slackTeamId: string; createdAt: string }[];
  channels?: { id: string; name: string }[];
  role?: { id: string; name: string } | null;
}): FetchCall[] {
  const calls: FetchCall[] = [];
  const workspaces = opts?.workspaces ?? [
    { id: "ws1", name: "Default", slackTeamId: "T1", createdAt: "2026-01-01T00:00:00Z" },
  ];
  const channels = opts?.channels ?? [
    { id: "C01ABC", name: "general" },
    { id: "C01XYZ", name: "morning-standup" },
  ];
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

      if (url.endsWith("/api/workspaces") || url.includes("/api/workspaces?")) {
        return new Response(JSON.stringify(workspaces), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/slack/channels")) {
        return new Response(JSON.stringify(channels), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/roles/")) {
        if (opts?.role === null) {
          return new Response(JSON.stringify({ error: "role not found" }), {
            status: 404, headers: { "Content-Type": "application/json" },
          });
        }
        const role = opts?.role ?? {
          id: "role-1", name: "勉強会チーム", eventActionId: "act-x",
        };
        return new Response(JSON.stringify(role), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return calls;
}

function renderForm(action: EventAction, opts?: Parameters<typeof installFetchSpy>[0]) {
  const onSaved = vi.fn();
  const calls = installFetchSpy(opts);
  render(
    <ToastProvider>
      <MorningStandupSettingsForm
        eventId={EVENT_ID}
        action={action}
        onSaved={onSaved}
      />
    </ToastProvider>,
  );
  return { onSaved, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MorningStandupSettingsForm smoke (003 PR9)", () => {
  it("初期値: themes が input に出る / 時刻 default 表示", async () => {
    renderForm(
      makeAction({
        channelId: "C01ABC",
        roleId: "role-xyz",
        themes: { mon: "Rust", wed: "Go" },
      }),
    );
    await waitFor(() => {
      expect(screen.getByDisplayValue("Rust")).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue("Go")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("ハードウェア")).toBeInTheDocument();
    // PR9: 時刻 default
    expect(screen.getByLabelText("リマインダー投稿時刻")).toHaveValue("07:30");
    expect(screen.getByLabelText("締切投稿時刻")).toHaveValue("08:00");
  });

  it("config の reminderTime / closeTime が反映される", async () => {
    renderForm(
      makeAction({ channelId: "C01ABC", reminderTime: "08:15", closeTime: "09:00" }),
    );
    await waitFor(() => {
      expect(screen.getByLabelText("リマインダー投稿時刻")).toHaveValue("08:15");
    });
    expect(screen.getByLabelText("締切投稿時刻")).toHaveValue("09:00");
  });

  it("ロール名表示: RoleNameDisplay が fetch して name を出す + ヒント維持", async () => {
    renderForm(makeAction({ channelId: "C1", roleId: "role-rrr" }), {
      role: { id: "role-rrr", name: "勉強会チーム" },
    });
    await waitFor(() => {
      expect(screen.getByText("勉強会チーム")).toBeInTheDocument();
    });
    expect(screen.getByText(/ID: role-rrr/)).toBeInTheDocument();
  });

  it("roleId 未設定 → 「未設定」表示 + fetch しない", async () => {
    const { calls } = renderForm(makeAction({ channelId: "C1" }));
    await waitFor(() => {
      expect(screen.getByText("未設定")).toBeInTheDocument();
    });
    expect(calls.some((c) => c.url.includes("/api/roles/"))).toBe(false);
  });

  it("ws=1 件のときは workspace dropdown を出さない", async () => {
    renderForm(makeAction({ channelId: "C1" }));
    // workspace の取得後、dropdown は出ないことを確認
    await waitFor(() => {
      expect(screen.queryByLabelText("ワークスペース")).toBeNull();
    });
  });

  it("ws=2 件以上 → workspace dropdown が出る", async () => {
    renderForm(makeAction({ channelId: "C1" }), {
      workspaces: [
        { id: "ws1", name: "WS-A", slackTeamId: "T1", createdAt: "2026-01-01T00:00:00Z" },
        { id: "ws2", name: "WS-B", slackTeamId: "T2", createdAt: "2026-01-01T00:00:00Z" },
      ],
    });
    await waitFor(() => {
      expect(screen.getByLabelText("ワークスペース")).toBeInTheDocument();
    });
  });

  it("SingleChannelPicker で channel 選択 + 保存 → PUT body に channelId / reminderTime / closeTime", async () => {
    const user = userEvent.setup();
    const { onSaved, calls } = renderForm(
      makeAction({ channelId: "", roleId: "role-1" }),
    );
    // channel picker から general を選択
    const addBtns = await screen.findAllByRole("button", { name: /\+ 追加/ });
    await user.click(addBtns[0]);

    await user.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    const putCall = calls.find(
      (c) => c.method === "PUT" && c.url.includes(`/orgs/${EVENT_ID}/actions/act-morning`),
    );
    expect(putCall).toBeDefined();
    const body = JSON.parse(JSON.parse(putCall!.body!).config);
    expect(body.channelId).toBe("C01ABC");
    expect(body.roleId).toBe("role-1");
    expect(body.reminderTime).toBe("07:30");
    expect(body.closeTime).toBe("08:00");
  });

  it("messageTemplates 空欄 → body から omit (default fallback)", async () => {
    const user = userEvent.setup();
    const { onSaved, calls } = renderForm(
      makeAction({ channelId: "C01ABC", roleId: "r" }),
    );
    await waitFor(() => expect(screen.getByLabelText("リマインダー投稿時刻")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const putCall = calls.find((c) => c.method === "PUT");
    const body = JSON.parse(JSON.parse(putCall!.body!).config);
    expect(body.messageTemplates).toBeUndefined();
  });

  it("時刻 HH:MM 不正 → error 表示 / 保存しない", async () => {
    const user = userEvent.setup();
    const { onSaved, calls } = renderForm(makeAction({ channelId: "C01ABC" }));
    await waitFor(() => expect(screen.getByLabelText("リマインダー投稿時刻")).toBeInTheDocument());
    const input = screen.getByLabelText("リマインダー投稿時刻") as HTMLInputElement;
    // type=time の input には直接不正値を入れにくいので fireEvent ベースで挑む
    input.value = "abc";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await user.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => {
      expect(screen.getByText(/HH:MM/)).toBeInTheDocument();
    });
    expect(calls.filter((c) => c.method === "PUT").length).toBe(0);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("reminderTime >= closeTime → error", async () => {
    const user = userEvent.setup();
    const { onSaved, calls } = renderForm(
      makeAction({ channelId: "C01ABC", reminderTime: "09:00", closeTime: "08:00" }),
    );
    await waitFor(() => expect(screen.getByLabelText("リマインダー投稿時刻")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => {
      expect(screen.getByText(/締切時刻はリマインダー時刻より後/)).toBeInTheDocument();
    });
    expect(calls.filter((c) => c.method === "PUT").length).toBe(0);
    expect(onSaved).not.toHaveBeenCalled();
  });
});
