import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WhitelistSettingsForm } from "../src/components/whitelist/WhitelistSettingsForm";
import type { EventAction } from "../src/types";
import { ToastProvider } from "../src/components/ui/Toast";

// 宗教イベント PR7: whitelist 設定タブのスモークテスト。
// observer:
//   - workspace / role 一覧 fetch → dropdown に NAME で並ぶ (ID は出さない)
//   - workspace / role 選択 + SingleChannelPicker で channel 選択できる
//   - 保存時 PUT body に { workspaceId, roleId, notifyChannelId } が乗る
//   - workspace / role / channel 未選択は保存を弾く

const EVENT_ID = "ev1";

function makeAction(config: object): EventAction {
  return {
    id: "act-wl",
    eventId: EVENT_ID,
    actionType: "whitelist",
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
  // event の action 一覧 (role_management を含む)
  actions?: { id: string; actionType: string }[];
  // role_management action 配下のロール一覧
  roles?: { id: string; name: string }[];
}): FetchCall[] {
  const calls: FetchCall[] = [];
  const workspaces = opts?.workspaces ?? [
    { id: "ws1", name: "宗教WS", slackTeamId: "T1", createdAt: "2026-01-01T00:00:00Z" },
  ];
  const channels = opts?.channels ?? [
    { id: "C0NOTIFY", name: "notify" },
    { id: "C0OTHER", name: "general" },
  ];
  const actions = opts?.actions ?? [{ id: "act-rm", actionType: "role_management" }];
  const roles = opts?.roles ?? [
    { id: "r1", name: "信者", description: null, parentRoleId: null, membersCount: 3, channelsCount: 0, createdAt: "x", updatedAt: "x" },
    { id: "r2", name: "幹部", description: null, parentRoleId: null, membersCount: 1, channelsCount: 0, createdAt: "x", updatedAt: "x" },
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
      // ロール一覧: /api/orgs/:eventId/actions/:actionId/roles
      if (method === "GET" && /\/api\/orgs\/[^/]+\/actions\/[^/]+\/roles$/.test(url)) {
        return json(roles);
      }
      // event の action 一覧: /api/orgs/:eventId/actions
      if (method === "GET" && /\/api\/orgs\/[^/]+\/actions$/.test(url)) {
        return json(actions);
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
      <WhitelistSettingsForm eventId={EVENT_ID} action={action} onSaved={onSaved} />
    </ToastProvider>,
  );
  return { onSaved, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WhitelistSettingsForm smoke (宗教 PR7)", () => {
  it("workspace dropdown が NAME で並ぶ (ID は出さない)", async () => {
    renderForm(makeAction({}));
    await waitFor(() => {
      expect(screen.getByLabelText("ワークスペース")).toBeInTheDocument();
    });
    expect(screen.getByRole("option", { name: "宗教WS" })).toBeInTheDocument();
    // 内部 ID (ws1) は表示しない
    expect(screen.queryByText("ws1")).not.toBeInTheDocument();
  });

  it("role dropdown が NAME で並ぶ (ID は出さない)", async () => {
    renderForm(makeAction({}));
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "信者" })).toBeInTheDocument();
    });
    expect(screen.getByRole("option", { name: "幹部" })).toBeInTheDocument();
    // 内部 ID (r1 / r2) は表示しない
    expect(screen.queryByText("r1")).not.toBeInTheDocument();
    expect(screen.queryByText("r2")).not.toBeInTheDocument();
  });

  it("初期 config の roleId が dropdown に反映される", async () => {
    renderForm(makeAction({ workspaceId: "ws1", roleId: "r2", notifyChannelId: "C0NOTIFY" }));
    await waitFor(() => {
      expect(screen.getByLabelText("ホワイトリスト ロール")).toHaveValue("r2");
    });
  });

  it("保存 → { workspaceId, roleId, notifyChannelId } が PUT body に乗る", async () => {
    const user = userEvent.setup();
    const { onSaved, calls } = renderForm(makeAction({}));

    // workspace は 1 件なので自動選択済み。role を選ぶ。
    const roleSelect = await screen.findByLabelText("ホワイトリスト ロール");
    await user.selectOptions(roleSelect, "r1");

    // SingleChannelPicker の候補から notify を追加
    const addBtns = await screen.findAllByRole("button", { name: /\+ 追加/ });
    await user.click(addBtns[0]); // notify (C0NOTIFY)

    await user.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    const putCall = calls.find(
      (c) => c.method === "PUT" && c.url.includes(`/orgs/${EVENT_ID}/actions/act-wl`),
    );
    expect(putCall).toBeDefined();
    const cfg = JSON.parse(JSON.parse(putCall!.body!).config);
    expect(cfg.workspaceId).toBe("ws1");
    expect(cfg.roleId).toBe("r1");
    expect(cfg.notifyChannelId).toBe("C0NOTIFY");
  });

  it("role 未選択は保存を弾く", async () => {
    const user = userEvent.setup();
    const { onSaved, calls } = renderForm(makeAction({}));
    // workspace は自動選択されるが role / channel は未選択。
    await screen.findByLabelText("ホワイトリスト ロール");
    await user.click(screen.getByRole("button", { name: /保存/ }));
    expect(calls.filter((c) => c.method === "PUT").length).toBe(0);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("channel 未選択は保存を弾く (role は選択済み)", async () => {
    const user = userEvent.setup();
    const { onSaved, calls } = renderForm(makeAction({}));
    const roleSelect = await screen.findByLabelText("ホワイトリスト ロール");
    await user.selectOptions(roleSelect, "r1");
    await user.click(screen.getByRole("button", { name: /保存/ }));
    expect(calls.filter((c) => c.method === "PUT").length).toBe(0);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("role が無い → 案内文を出す", async () => {
    renderForm(makeAction({}), { roles: [] });
    await waitFor(() => {
      expect(screen.getByText(/ロールがありません/)).toBeInTheDocument();
    });
  });
});
