import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KejimeSettingsForm } from "../src/components/kejime/KejimeSettingsForm";
import type { EventAction } from "../src/types";
import { ToastProvider } from "../src/components/ui/Toast";

// 003 PR7 → PR8 → PR9: kejime_tracker 設定タブのスモークテスト。
// PR9 で ChannelSelector → SingleChannelPicker。
// observer:
//   - workspace 一覧 fetch + SingleChannelPicker で channel 選択できる
//   - 保存時 PUT body 検証
//   - minArticleLength バリデーション
//   - 空欄 channelId 許可

const EVENT_ID = "ev1";

function makeAction(config: object): EventAction {
  return {
    id: "act-kejime",
    eventId: EVENT_ID,
    actionType: "kejime_tracker",
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
    { id: "C0KEJI", name: "kejime" },
    { id: "C0NEW", name: "kejime-test" },
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
          id: "r1", name: "勉強会チーム", eventActionId: "act-x",
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
      <KejimeSettingsForm
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

describe("KejimeSettingsForm smoke (003 PR9)", () => {
  it("初期値: minArticleLength が反映される", async () => {
    renderForm(
      makeAction({ kejimeChannelId: "C0KEJI", roleId: "role-rrr", minArticleLength: 800 }),
    );
    expect(screen.getByDisplayValue("800")).toBeInTheDocument();
  });

  it("minArticleLength 未設定なら default 500", () => {
    renderForm(makeAction({ kejimeChannelId: "C0KEJI" }));
    expect(screen.getByDisplayValue("500")).toBeInTheDocument();
  });

  it("ロール名表示: name のみ (PR11: ID は出さない)", async () => {
    renderForm(makeAction({ roleId: "r1" }), {
      role: { id: "r1", name: "勉強会チーム" },
    });
    await waitFor(() => {
      expect(screen.getByText("勉強会チーム")).toBeInTheDocument();
    });
    // PR11: 内部 ID は表示しない
    expect(screen.queryByText(/ID:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/r1/)).not.toBeInTheDocument();
  });

  it("roleId 未設定 → 「未設定」", async () => {
    renderForm(makeAction({ kejimeChannelId: "C0KEJI" }));
    await waitFor(() => {
      expect(screen.getByText("未設定")).toBeInTheDocument();
    });
  });

  it("ロール取得失敗 → 警告 UI", async () => {
    renderForm(makeAction({ roleId: "gone" }), { role: null });
    await waitFor(() => {
      expect(screen.getByLabelText("ロール名取得失敗")).toBeInTheDocument();
    });
  });

  it("ws=1 → workspace dropdown を出さない", async () => {
    renderForm(makeAction({ kejimeChannelId: "C0KEJI" }));
    await waitFor(() => {
      expect(screen.queryByLabelText("ワークスペース")).toBeNull();
    });
  });

  it("ws=2+ → workspace dropdown が出る", async () => {
    renderForm(makeAction({ kejimeChannelId: "C0KEJI" }), {
      workspaces: [
        { id: "ws1", name: "WS-A", slackTeamId: "T1", createdAt: "2026-01-01T00:00:00Z" },
        { id: "ws2", name: "WS-B", slackTeamId: "T2", createdAt: "2026-01-01T00:00:00Z" },
      ],
    });
    await waitFor(() => {
      expect(screen.getByLabelText("ワークスペース")).toBeInTheDocument();
    });
  });

  it("保存 → SingleChannelPicker で選択した kejimeChannelId が PUT body に乗る", async () => {
    const user = userEvent.setup();
    const { onSaved, calls } = renderForm(
      makeAction({ kejimeChannelId: "", roleId: "r1" }),
    );
    const addBtns = await screen.findAllByRole("button", { name: /\+ 追加/ });
    await user.click(addBtns[0]); // kejime (C0KEJI)

    const minInput = screen.getByLabelText("記事の最小文字数");
    await user.clear(minInput);
    await user.type(minInput, "600");

    await user.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    const putCall = calls.find(
      (c) => c.method === "PUT" && c.url.includes(`/orgs/${EVENT_ID}/actions/act-kejime`),
    );
    expect(putCall).toBeDefined();
    const body = JSON.parse(JSON.parse(putCall!.body!).config);
    expect(body.kejimeChannelId).toBe("C0KEJI");
    expect(body.minArticleLength).toBe(600);
    expect(body.roleId).toBe("r1");
  });

  it("minArticleLength = 0 は弾く", async () => {
    const user = userEvent.setup();
    const { onSaved, calls } = renderForm(makeAction({ kejimeChannelId: "C0KEJI" }));
    const minInput = screen.getByLabelText("記事の最小文字数");
    await user.clear(minInput);
    await user.type(minInput, "0");
    expect(minInput).toHaveAttribute("aria-invalid", "true");
    await user.click(screen.getByRole("button", { name: /保存/ }));
    expect(calls.filter((c) => c.method === "PUT").length).toBe(0);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("minArticleLength = 負数 は弾く", async () => {
    const user = userEvent.setup();
    const { onSaved, calls } = renderForm(makeAction({ kejimeChannelId: "C0KEJI" }));
    const minInput = screen.getByLabelText("記事の最小文字数");
    await user.clear(minInput);
    await user.type(minInput, "-3");
    expect(minInput).toHaveAttribute("aria-invalid", "true");
    await user.click(screen.getByRole("button", { name: /保存/ }));
    expect(calls.filter((c) => c.method === "PUT").length).toBe(0);
    expect(onSaved).not.toHaveBeenCalled();
  });

  // PR15: 通知文面 textarea のスモーク
  it("PR15: 既存の messageTemplates が textarea にロードされる", () => {
    renderForm(
      makeAction({
        kejimeChannelId: "C0KEJI", roleId: "r1",
        messageTemplates: {
          approved: "OK <@{user}>",
          rejectedShort: "短い ({length})",
          rejectedDomain: "Qiita のみ",
          rejectedFetchError: "取得失敗",
        },
      }),
    );
    expect(screen.getByLabelText("通知文面 (承認時)")).toHaveValue("OK <@{user}>");
    expect(screen.getByLabelText("通知文面 (却下: 文字数不足)")).toHaveValue("短い ({length})");
    expect(screen.getByLabelText("通知文面 (却下: 非 Qiita ドメイン)")).toHaveValue("Qiita のみ");
    expect(screen.getByLabelText("通知文面 (却下: 記事取得失敗)")).toHaveValue("取得失敗");
  });

  it("PR15: textarea を編集して保存 → messageTemplates が PUT body に乗る", async () => {
    const user = userEvent.setup();
    const { onSaved, calls } = renderForm(
      makeAction({ kejimeChannelId: "C0KEJI", roleId: "r1" }),
    );
    const approved = screen.getByLabelText("通知文面 (承認時)");
    await user.clear(approved);
    // userEvent.type は "{...}" を特殊キーとして扱うので {{ で escape する。
    await user.type(approved, "🆗 <@{{user}>");
    await user.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const putCall = calls.find(
      (c) => c.method === "PUT" && c.url.includes(`/orgs/${EVENT_ID}/actions/act-kejime`),
    );
    const body = JSON.parse(JSON.parse(putCall!.body!).config);
    expect(body.messageTemplates).toBeDefined();
    expect(body.messageTemplates.approved).toBe("🆗 <@{user}>");
    // 他 3 種は空文字 (default フォールバック)
    expect(body.messageTemplates.rejectedShort).toBe("");
  });
});
