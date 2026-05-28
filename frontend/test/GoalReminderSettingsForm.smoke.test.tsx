import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GoalReminderSettingsForm } from "../src/components/goal-reminder/GoalReminderSettingsForm";
import type { EventAction } from "../src/types";
import { ToastProvider } from "../src/components/ui/Toast";

// 宗教イベント goal_reminder PR2: 設定タブのスモークテスト。
// observer:
//   - workspace 一覧 fetch → dropdown に NAME で並ぶ (ID は出さない)
//   - default 文面 / 目標テキストが prefill される
//   - フィールドを編集して保存すると PUT body の config に値が乗る

const EVENT_ID = "ev1";

function makeAction(config: object): EventAction {
  return {
    id: "act-gr",
    eventId: EVENT_ID,
    actionType: "goal_reminder",
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
    { id: "C0GOAL", name: "goal" },
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
      <GoalReminderSettingsForm eventId={EVENT_ID} action={action} onSaved={onSaved} />
    </ToastProvider>,
  );
  return { onSaved, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GoalReminderSettingsForm smoke (宗教 PR2)", () => {
  it("workspace dropdown が NAME で並ぶ (ID は出さない)", async () => {
    renderForm(makeAction({}));
    await waitFor(() => {
      expect(screen.getByLabelText("ワークスペース")).toBeInTheDocument();
    });
    expect(screen.getByRole("option", { name: "宗教WS" })).toBeInTheDocument();
    expect(screen.queryByText("ws1")).not.toBeInTheDocument();
  });

  it("空 config でも default 文面 / 目標テキストが prefill される", async () => {
    renderForm(makeAction({}));
    expect(await screen.findByLabelText("目標テキスト")).toHaveValue("次世代の宗教を作る");
    expect(screen.getByLabelText("朝の投稿時刻")).toHaveValue("08:00");
    expect(screen.getByLabelText("夜の投稿時刻")).toHaveValue("22:00");
    expect((screen.getByLabelText("朝の文面") as HTMLTextAreaElement).value).toContain(
      "{goal}",
    );
  });

  it("初期 config の値が各フィールドに反映される", async () => {
    renderForm(
      makeAction({
        schemaVersion: 1,
        workspaceId: "ws1",
        channelId: "C0GOAL",
        morningTime: "07:00",
        nightTime: "23:00",
        frequency: "weekday",
        mention: "channel",
        goalText: "世界を変える",
      }),
    );
    expect(await screen.findByLabelText("目標テキスト")).toHaveValue("世界を変える");
    expect(screen.getByLabelText("朝の投稿時刻")).toHaveValue("07:00");
    expect(screen.getByLabelText("投稿頻度")).toHaveValue("weekday");
    expect(screen.getByLabelText("メンション")).toHaveValue("channel");
  });

  it("保存 → 選んだ値を含む config が PUT body に乗る", async () => {
    const user = userEvent.setup();
    const { onSaved, calls } = renderForm(makeAction({}));

    // workspace は 1 件なので自動選択済み。channel を候補から追加。
    const addBtns = await screen.findAllByRole("button", { name: /\+ 追加/ });
    await user.click(addBtns[0]); // goal (C0GOAL)

    const goalInput = screen.getByLabelText("目標テキスト");
    await user.clear(goalInput);
    await user.type(goalInput, "宇宙を制覇する");

    await user.selectOptions(screen.getByLabelText("投稿頻度"), "weekday");
    await user.selectOptions(screen.getByLabelText("メンション"), "channel");

    await user.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    const putCall = calls.find(
      (c) => c.method === "PUT" && c.url.includes(`/orgs/${EVENT_ID}/actions/act-gr`),
    );
    expect(putCall).toBeDefined();
    const cfg = JSON.parse(JSON.parse(putCall!.body!).config);
    expect(cfg.schemaVersion).toBe(1);
    expect(cfg.workspaceId).toBe("ws1");
    expect(cfg.channelId).toBe("C0GOAL");
    expect(cfg.goalText).toBe("宇宙を制覇する");
    expect(cfg.frequency).toBe("weekday");
    expect(cfg.mention).toBe("channel");
  });

  it("channel 未選択は保存を弾く", async () => {
    const user = userEvent.setup();
    const { onSaved, calls } = renderForm(makeAction({}));
    await screen.findByLabelText("目標テキスト");
    await user.click(screen.getByRole("button", { name: /保存/ }));
    expect(calls.filter((c) => c.method === "PUT").length).toBe(0);
    expect(onSaved).not.toHaveBeenCalled();
  });
});
