import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TutorialConfigForm } from "../src/components/tutorial/TutorialConfigForm";
import type { EventAction } from "../src/types";
import { ToastProvider } from "../src/components/ui/Toast";

// 宗教イベント tutorial PR2: 設定タブのスモークテスト。
// observer:
//   - workspace 一覧 fetch → dropdown に NAME で並ぶ (ID は出さない)
//   - 空 config でも default 案内文が prefill される
//   - トリガーチャンネルを選び保存すると PUT body の config に値が乗る

const EVENT_ID = "ev1";

function makeAction(config: object): EventAction {
  return {
    id: "act-tut",
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
  workspaces?: { id: string; name: string; slackTeamId: string; createdAt: string }[];
  channels?: { id: string; name: string }[];
}): FetchCall[] {
  const calls: FetchCall[] = [];
  const workspaces = opts?.workspaces ?? [
    { id: "ws1", name: "宗教WS", slackTeamId: "T1", createdAt: "2026-01-01T00:00:00Z" },
  ];
  const channels = opts?.channels ?? [
    { id: "C0TRIG", name: "welcome" },
    { id: "C0OTHER", name: "general" },
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

      const json = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { "Content-Type": "application/json" },
        });

      if (url.endsWith("/api/workspaces") || url.includes("/api/workspaces?")) {
        return json(workspaces);
      }
      if (url.includes("/api/slack/channels")) {
        return json(channels);
      }
      return json({ ok: true });
    }),
  );
  return calls;
}

function renderForm(action: EventAction, opts?: Parameters<typeof installFetchSpy>[0]) {
  const onSaved = vi.fn();
  const calls = installFetchSpy(opts);
  render(
    <ToastProvider>
      <TutorialConfigForm eventId={EVENT_ID} action={action} onSaved={onSaved} />
    </ToastProvider>,
  );
  return { onSaved, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TutorialConfigForm smoke (宗教 PR2)", () => {
  it("workspace dropdown が NAME で並ぶ (ID は出さない)", async () => {
    renderForm(makeAction({}));
    await waitFor(() => {
      expect(screen.getByLabelText("ワークスペース")).toBeInTheDocument();
    });
    expect(screen.getByRole("option", { name: "宗教WS" })).toBeInTheDocument();
    expect(screen.queryByText("ws1")).not.toBeInTheDocument();
  });

  it("空 config でも default 案内文が prefill される", async () => {
    renderForm(makeAction({}));
    const ta = (await screen.findByLabelText("案内文")) as HTMLTextAreaElement;
    expect(ta.value).toContain("{workspace}");
    expect(ta.value).toContain("ようこそ");
  });

  // 宗教 PR4: 命名規則テンプレ同期。default 案内文の例が
  // 「漢字フルネーム ( ローマ字 )」形式 (高岡 己太朗 ( Takaoka Kotaro )) になっている。
  it("default 案内文の命名規則例が同期済み (高岡 己太朗 ( Takaoka Kotaro ))", async () => {
    renderForm(makeAction({}));
    const ta = (await screen.findByLabelText("案内文")) as HTMLTextAreaElement;
    expect(ta.value).toContain("高岡 己太朗 ( Takaoka Kotaro )");
  });

  it("初期 config の値が各フィールドに反映される", async () => {
    renderForm(
      makeAction({
        schemaVersion: 1,
        workspaceId: "ws1",
        triggerChannelId: "C0TRIG",
        deliveryMode: "channel",
        postChannelId: "C0OTHER",
        template: "カスタム文面 {user}",
      }),
    );
    const ta = (await screen.findByLabelText("案内文")) as HTMLTextAreaElement;
    expect(ta.value).toBe("カスタム文面 {user}");
    expect(screen.getByLabelText("送信方法")).toHaveValue("channel");
  });

  it("deliveryMode=channel のとき投稿先チャンネルが表示される", async () => {
    const user = userEvent.setup();
    renderForm(makeAction({}));
    await screen.findByLabelText("送信方法");
    // 既定は dm なので投稿先 channel picker は出ない (channel picker が 1 つ = trigger のみ)。
    await user.selectOptions(screen.getByLabelText("送信方法"), "channel");
    await waitFor(() => {
      expect(screen.getByText("投稿先チャンネル")).toBeInTheDocument();
    });
  });

  it("保存 → 選んだ値を含む config が PUT body に乗る", async () => {
    const user = userEvent.setup();
    const { onSaved, calls } = renderForm(makeAction({}));

    // workspace は 1 件なので自動選択済み。trigger channel を候補から追加。
    const addBtns = await screen.findAllByRole("button", { name: /\+ 追加/ });
    await user.click(addBtns[0]); // welcome (C0TRIG)

    await user.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    const putCall = calls.find(
      (c) => c.method === "PUT" && c.url.includes(`/orgs/${EVENT_ID}/actions/act-tut`),
    );
    expect(putCall).toBeDefined();
    const cfg = JSON.parse(JSON.parse(putCall!.body!).config);
    expect(cfg.schemaVersion).toBe(1);
    expect(cfg.workspaceId).toBe("ws1");
    expect(cfg.triggerChannelId).toBe("C0TRIG");
    expect(cfg.deliveryMode).toBe("dm");
    expect(cfg.template).toContain("ようこそ");
  });

  it("workspace 未選択は保存を弾く", async () => {
    const user = userEvent.setup();
    const { onSaved, calls } = renderForm(makeAction({}), { workspaces: [] });
    await screen.findByLabelText("案内文");
    await user.click(screen.getByRole("button", { name: /保存/ }));
    expect(calls.filter((c) => c.method === "PUT").length).toBe(0);
    expect(onSaved).not.toHaveBeenCalled();
  });
});
