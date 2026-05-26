import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MorningStandupSettingsForm } from "../src/components/morning-standup/MorningStandupSettingsForm";
import type { EventAction } from "../src/types";
import { ToastProvider } from "../src/components/ui/Toast";

// 003 PR7 → PR8: morning_standup の設定タブのスモークテスト。
// PR8 で channelId は ChannelSelector / roleId は RoleNameDisplay に置換、
// messageTemplates (reminder / close textarea) を追加。
// observer:
//   - ChannelSelector の <select> に既存 channelId が反映される
//   - RoleNameDisplay がロール名 fetch を試みる (mock api)
//   - 保存時 PUT body に channelId / themes / messageTemplates が乗る
//   - 不正な channelId は保存ブロック (ChannelSelector からは出ない想定だが防御)
//   - messageTemplates 空欄なら body から omit (default fallback)

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

// PR8: ChannelSelector が GET /api/slack/channels を、
//      RoleNameDisplay が GET /api/roles/:id を呼ぶので、それぞれ mock する。
function installFetchSpy(opts?: {
  channels?: { id: string; name: string }[];
  role?: { id: string; name: string } | null;
}): FetchCall[] {
  const calls: FetchCall[] = [];
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

      if (url.includes("/api/slack/channels")) {
        return new Response(JSON.stringify(channels), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/roles/")) {
        if (opts?.role === null) {
          return new Response(JSON.stringify({ error: "role not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }
        const role = opts?.role ?? {
          id: "role-1",
          name: "勉強会チーム",
          eventActionId: "act-x",
        };
        return new Response(JSON.stringify(role), {
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

describe("MorningStandupSettingsForm smoke (003 PR8)", () => {
  it("初期値: channel が ChannelSelector に反映 / themes が input に出る", async () => {
    renderForm(
      makeAction({
        channelId: "C01ABC",
        roleId: "role-xyz",
        themes: { mon: "Rust", wed: "Go" },
      }),
    );
    // ChannelSelector の <select> が読み込み完了したら value=C01ABC
    await waitFor(() => {
      const select = screen.getByRole("combobox");
      expect((select as HTMLSelectElement).value).toBe("C01ABC");
    });
    expect(screen.getByDisplayValue("Rust")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Go")).toBeInTheDocument();
    // 未指定の曜日はデフォルト placeholder
    expect(screen.getByPlaceholderText("ハードウェア")).toBeInTheDocument();
  });

  it("ロール名表示: RoleNameDisplay が fetch して name を出す + ヒント維持", async () => {
    renderForm(makeAction({ channelId: "C1", roleId: "role-rrr" }), {
      role: { id: "role-rrr", name: "勉強会チーム" },
    });
    await waitFor(() => {
      expect(screen.getByText("勉強会チーム")).toBeInTheDocument();
    });
    expect(screen.getByText(/ID: role-rrr/)).toBeInTheDocument();
    expect(
      screen.getByText(/メンバー」タブ.*勉強会チーム/),
    ).toBeInTheDocument();
  });

  it("roleId 未設定 → 「未設定」表示 + fetch しない", async () => {
    const { calls } = renderForm(makeAction({ channelId: "C1" }));
    await waitFor(() => {
      expect(screen.getByText("未設定")).toBeInTheDocument();
    });
    expect(calls.some((c) => c.url.includes("/api/roles/"))).toBe(false);
  });

  it("ロール名取得失敗 → 警告 UI", async () => {
    renderForm(makeAction({ channelId: "C1", roleId: "role-gone" }), {
      role: null,
    });
    await waitFor(() => {
      expect(screen.getByLabelText("ロール名取得失敗")).toBeInTheDocument();
    });
  });

  it("保存ボタン: ChannelSelector 選択 + themes + messageTemplates が body に乗る", async () => {
    const user = userEvent.setup();
    const { onSaved, calls } = renderForm(
      makeAction({ channelId: "", roleId: "role-1" }),
    );
    // ChannelSelector 読み込み待ち
    const select = await screen.findByRole("combobox");
    await user.selectOptions(select, "C01XYZ");

    const monInput = screen.getByLabelText("月曜テーマ");
    await user.type(monInput, "Kotlin");

    const reminderTa = screen.getByLabelText("7:30 リマインダー文面");
    // userEvent.type は { を keyboard sequence と解釈するので {{ でエスケープ
    await user.type(reminderTa, "Hi {{theme}");

    await user.click(screen.getByRole("button", { name: /保存/ }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const putCall = calls.find(
      (c) =>
        c.method === "PUT" &&
        c.url.includes(`/orgs/${EVENT_ID}/actions/act-morning`),
    );
    expect(putCall).toBeDefined();
    const body = JSON.parse(JSON.parse(putCall!.body!).config);
    expect(body.channelId).toBe("C01XYZ");
    expect(body.themes).toEqual({ mon: "Kotlin" });
    expect(body.roleId).toBe("role-1");
    expect(body.messageTemplates).toEqual({ reminder: "Hi {theme}" });
  });

  it("messageTemplates 空欄 → body から omit (default fallback)", async () => {
    const user = userEvent.setup();
    const { onSaved, calls } = renderForm(
      makeAction({ channelId: "C01ABC", roleId: "r" }),
    );
    await screen.findByRole("combobox");
    await user.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const putCall = calls.find((c) => c.method === "PUT");
    const body = JSON.parse(JSON.parse(putCall!.body!).config);
    expect(body.messageTemplates).toBeUndefined();
  });

  it("空欄 channelId 保存は許可される (cron skip 用)", async () => {
    const user = userEvent.setup();
    const { onSaved, calls } = renderForm(makeAction({ channelId: "C01ABC" }));
    const select = await screen.findByRole("combobox");
    await user.selectOptions(select, ""); // "-- チャンネルを選択 --"
    await user.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const putCall = calls.find((c) => c.method === "PUT");
    expect(putCall).toBeDefined();
    const body = JSON.parse(JSON.parse(putCall!.body!).config);
    expect(body.channelId).toBe("");
  });
});
