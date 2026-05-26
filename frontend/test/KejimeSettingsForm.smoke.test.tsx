import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KejimeSettingsForm } from "../src/components/kejime/KejimeSettingsForm";
import type { EventAction } from "../src/types";
import { ToastProvider } from "../src/components/ui/Toast";

// 003 PR7: kejime_tracker の設定タブのスモークテスト。
// observer:
//   - 初期値が config から読まれる (kejimeChannelId / minArticleLength / roleId)
//   - 保存時に PUT で body に正しい値が乗る
//   - 不正な kejimeChannelId は保存ブロック + エラー
//   - minArticleLength = 0 / 負数 / 非整数 は弾く
//   - 空欄 channelId は許可される (cron skip)

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

describe("KejimeSettingsForm smoke (003 PR7)", () => {
  it("初期値が config から読まれる", () => {
    renderForm(
      makeAction({
        kejimeChannelId: "C0KEJI",
        roleId: "role-rrr",
        minArticleLength: 800,
      }),
    );
    expect(screen.getByDisplayValue("C0KEJI")).toBeInTheDocument();
    expect(screen.getByDisplayValue("role-rrr")).toBeInTheDocument();
    expect(screen.getByDisplayValue("800")).toBeInTheDocument();
  });

  it("minArticleLength 未設定なら default 500 が出る", () => {
    renderForm(makeAction({ kejimeChannelId: "C1" }));
    expect(screen.getByDisplayValue("500")).toBeInTheDocument();
  });

  it("ロール ID は readonly + ヒント", () => {
    renderForm(makeAction({ roleId: "r1" }));
    const roleInput = screen.getByLabelText("勉強会チーム ロール ID");
    expect(roleInput).toHaveAttribute("readonly");
    expect(
      screen.getByText(/メンバー」タブ.*勉強会チーム/),
    ).toBeInTheDocument();
  });

  it("保存 → PUT で kejimeChannelId / minArticleLength が body に乗る", async () => {
    const user = userEvent.setup();
    const { onSaved, calls } = renderForm(
      makeAction({ kejimeChannelId: "", roleId: "r1" }),
    );
    const channelInput = screen.getByLabelText("けじめチャンネル ID");
    await user.type(channelInput, "C0NEW");
    const minInput = screen.getByLabelText("記事の最小文字数");
    await user.clear(minInput);
    await user.type(minInput, "600");

    await user.click(screen.getByRole("button", { name: /保存/ }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const putCall = calls.find(
      (c) =>
        c.method === "PUT" &&
        c.url.includes(`/orgs/${EVENT_ID}/actions/act-kejime`),
    );
    expect(putCall).toBeDefined();
    const body = JSON.parse(JSON.parse(putCall!.body!).config);
    expect(body.kejimeChannelId).toBe("C0NEW");
    expect(body.minArticleLength).toBe(600);
    expect(body.roleId).toBe("r1"); // 温存
  });

  it("不正な kejimeChannelId は保存ブロック + エラー表示", async () => {
    const user = userEvent.setup();
    const { onSaved, calls } = renderForm(makeAction({}));
    const input = screen.getByLabelText("けじめチャンネル ID");
    await user.type(input, "BADCHAN");
    expect(input).toHaveAttribute("aria-invalid", "true");

    await user.click(screen.getByRole("button", { name: /保存/ }));
    expect(
      screen.getByText(/kejimeChannelId は Slack の channel ID/),
    ).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "PUT").length).toBe(0);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("minArticleLength = 0 は弾く", async () => {
    const user = userEvent.setup();
    const { onSaved, calls } = renderForm(makeAction({ kejimeChannelId: "C1" }));
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
    const { onSaved, calls } = renderForm(makeAction({ kejimeChannelId: "C1" }));
    const minInput = screen.getByLabelText("記事の最小文字数");
    await user.clear(minInput);
    await user.type(minInput, "-3");
    expect(minInput).toHaveAttribute("aria-invalid", "true");
    await user.click(screen.getByRole("button", { name: /保存/ }));
    expect(calls.filter((c) => c.method === "PUT").length).toBe(0);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("空欄 channelId 保存は許可される", async () => {
    const user = userEvent.setup();
    const { onSaved, calls } = renderForm(
      makeAction({ kejimeChannelId: "C-OLD", minArticleLength: 500 }),
    );
    const input = screen.getByLabelText("けじめチャンネル ID");
    await user.clear(input);

    await user.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const putCall = calls.find((c) => c.method === "PUT");
    expect(putCall).toBeDefined();
    const body = JSON.parse(JSON.parse(putCall!.body!).config);
    expect(body.kejimeChannelId).toBe("");
  });
});
