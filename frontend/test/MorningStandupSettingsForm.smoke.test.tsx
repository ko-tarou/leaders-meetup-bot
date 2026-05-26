import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MorningStandupSettingsForm } from "../src/components/morning-standup/MorningStandupSettingsForm";
import type { EventAction } from "../src/types";
import { ToastProvider } from "../src/components/ui/Toast";

// 003 PR7: morning_standup の設定タブのスモークテスト。
// observer:
//   - 初期値が config から読まれる (channelId / themes / roleId readonly)
//   - 保存時に PUT /orgs/:eventId/actions/:actionId に正しい body
//   - 不正な channelId ("C" で始まらない) は保存ブロック + エラー表示
//   - 空欄 channelId は許可される

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
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return calls;
}

function renderForm(action: EventAction) {
  const onSaved = vi.fn();
  const calls = installFetchSpy();
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

describe("MorningStandupSettingsForm smoke (003 PR7)", () => {
  it("初期値が config から読まれる (channelId / themes / roleId)", () => {
    renderForm(
      makeAction({
        channelId: "C01ABC",
        roleId: "role-xyz",
        themes: { mon: "Rust", wed: "Go" },
      }),
    );
    expect(screen.getByDisplayValue("C01ABC")).toBeInTheDocument();
    expect(screen.getByDisplayValue("role-xyz")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Rust")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Go")).toBeInTheDocument();
    // 未指定の曜日はデフォルト placeholder
    expect(
      screen.getByPlaceholderText("ハードウェア"),
    ).toBeInTheDocument();
  });

  it("ロール ID は readonly + ヒントが出る", () => {
    renderForm(makeAction({ channelId: "C1", roleId: "role-rrr" }));
    const roleInput = screen.getByLabelText("勉強会チーム ロール ID");
    expect(roleInput).toHaveAttribute("readonly");
    expect(
      screen.getByText(/メンバー」タブ.*勉強会チーム/),
    ).toBeInTheDocument();
  });

  it("保存ボタン → PUT で channelId + themes が body に乗る", async () => {
    const user = userEvent.setup();
    const { onSaved, calls } = renderForm(
      makeAction({ channelId: "", roleId: "role-1" }),
    );
    const channelInput = screen.getByLabelText("朝活会チャンネル ID");
    await user.type(channelInput, "C01XYZ");
    // 月曜テーマだけ書き換え
    const monInput = screen.getByLabelText("月曜テーマ");
    await user.type(monInput, "Kotlin");

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
    // roleId は initial が温存される
    expect(body.roleId).toBe("role-1");
  });

  it("不正な channelId (C で始まらない) は保存ブロック + エラー表示", async () => {
    const user = userEvent.setup();
    const { onSaved, calls } = renderForm(makeAction({}));
    const input = screen.getByLabelText("朝活会チャンネル ID");
    await user.type(input, "X01BAD");
    expect(input).toHaveAttribute("aria-invalid", "true");

    await user.click(screen.getByRole("button", { name: /保存/ }));
    expect(
      screen.getByText(/channelId は Slack の channel ID/),
    ).toBeInTheDocument();
    // PUT は飛ばない
    expect(calls.filter((c) => c.method === "PUT").length).toBe(0);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("空欄 channelId 保存は許可される (cron skip 用)", async () => {
    const user = userEvent.setup();
    const { onSaved, calls } = renderForm(
      makeAction({ channelId: "C-OLD" }),
    );
    const input = screen.getByLabelText("朝活会チャンネル ID");
    await user.clear(input);

    await user.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const putCall = calls.find((c) => c.method === "PUT");
    expect(putCall).toBeDefined();
    const body = JSON.parse(JSON.parse(putCall!.body!).config);
    expect(body.channelId).toBe("");
  });
});
