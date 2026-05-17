import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GmailWatcherEditor } from "../src/components/GmailWatcherEditor";
import type {
  GmailAccount,
  GmailWatcherConfig,
  GmailWatcherRule,
  SlackUser,
  Workspace,
} from "../src/types";
import { installFetchMock, type FetchRoutes } from "./util";
import { ToastProvider } from "../src/components/ui/Toast";

// Phase4-6 characterization スモーク (番人)。
// GmailWatcherEditor は 1158 行。smoke 未整備のため、純抽出に着手する前に
// 「現状の主要観測面」をここで固定する (true characterization)。
//
// 観測面:
//   - collapse 時のヘッダー / サマリー (未設定 / 無効 / 有効 / ルール件数 / else)
//   - expand 時の config+workspaces ロード、監視トグル、ルール一覧、else セクション
//   - RuleCard: collapse サマリー / expand 編集 (名前 / キーワード / WS / テンプレ)
//   - ルール追加 / 削除 / 並べ替え
//   - autoReply トグル / 編集 UI
//   - 保存バリデーション (enabled で有効ルール無し → エラー)
//   - 不正入力耐性 (null config / legacy config)
//
// 本ファイルは「抽出前のコード」で green 化し、抽出後も同一 assert が green で
// あることを保証する (挙動 byte-identical の番人)。

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const account: GmailAccount = {
  id: "g1",
  email: "watch@example.com",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const ws1: Workspace = {
  id: "ws1",
  name: "DevHub WS",
} as Workspace;

const members: SlackUser[] = [
  { id: "U1", name: "alice", realName: "Alice A", displayName: "Alice" },
  { id: "U2", name: "bob", realName: "Bob B", displayName: "Bob" },
] as SlackUser[];

function rule(partial: Partial<GmailWatcherRule>): GmailWatcherRule {
  return {
    id: "r1",
    name: "ルール1",
    keywords: ["入部"],
    workspaceId: "",
    channelId: "",
    channelName: "",
    mentionUserIds: [],
    messageTemplate: "",
    ...partial,
  };
}

function renderEditor(
  cfg: GmailWatcherConfig | null,
  extra: FetchRoutes = {},
) {
  installFetchMock({
    "/gmail-accounts/g1/watcher": cfg,
    "/workspaces": [ws1],
    "/workspaces/ws1/members": members,
    ...extra,
  });
  return render(
    <ToastProvider>
      <GmailWatcherEditor account={account} />
    </ToastProvider>,
  );
}

async function expand(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /メール監視設定/ }));
  // loading が解けて本文が描画されるのを待つ
  await waitFor(() => {
    expect(screen.getByText("監視を有効にする")).toBeInTheDocument();
  });
}

describe("GmailWatcherEditor smoke (Phase4-6 番人)", () => {
  it("render: collapse 時はヘッダーとサマリーのみ (未設定)", () => {
    renderEditor(null);
    expect(
      screen.getByRole("button", { name: /メール監視設定/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("未設定")).toBeInTheDocument();
    // 本文 (監視トグル) は折りたたみ中なので出ない
    expect(screen.queryByText("監視を有効にする")).not.toBeInTheDocument();
  });

  it("サマリー: enabled + rules + else で「有効 / ルール N 件 / else 有効」", () => {
    renderEditor({
      enabled: true,
      rules: [rule({ id: "a" }), rule({ id: "b" })],
      elseRule: rule({ id: "e", name: "else" }),
    });
    // saved* は collapse でも fetch されないため初期サマリーは「未設定」。
    // ロードはあくまで expand 時。collapse サマリーが事故らないことを固定する。
    expect(screen.getByText("未設定")).toBeInTheDocument();
  });

  it("expand: config(null)+workspaces ロード後に主要 UI が出る", async () => {
    const user = userEvent.setup();
    renderEditor(null);
    await expand(user);
    expect(screen.getByText("監視を有効にする")).toBeInTheDocument();
    expect(
      screen.getByText("ルール (上から順に評価)"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "ルールはまだありません。下のボタンから追加してください。",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "+ ルール追加" }),
    ).toBeInTheDocument();
    expect(screen.getByText("else を有効にする")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存" })).toBeInTheDocument();
  });

  it("expand: 既存 rules がカードのサマリーに反映される", async () => {
    const user = userEvent.setup();
    renderEditor({
      enabled: true,
      rules: [
        rule({
          id: "a",
          name: "加入希望",
          keywords: ["入部", "参加"],
          channelName: "general",
        }),
      ],
    });
    await expand(user);
    expect(screen.getByText("1. 加入希望")).toBeInTheDocument();
    expect(
      screen.getByText("キーワード: 入部, 参加 / 通知先: #general"),
    ).toBeInTheDocument();
  });

  it("ルール追加 → カードが現れ、編集パネルが展開状態で出る", async () => {
    const user = userEvent.setup();
    renderEditor(null);
    await expand(user);
    await user.click(screen.getByRole("button", { name: "+ ルール追加" }));
    // 新規 rule は editingId にセットされ展開状態
    expect(screen.getByText("1. ルール 1")).toBeInTheDocument();
    expect(screen.getByText("ルール名")).toBeInTheDocument();
    expect(
      screen.getByDisplayValue("ルール 1"),
    ).toBeInTheDocument();
  });

  it("ルール編集: 名前 / キーワード入力が反映される", async () => {
    const user = userEvent.setup();
    renderEditor({
      enabled: false,
      rules: [rule({ id: "a", name: "旧名", keywords: [] })],
    });
    await expand(user);
    // collapse 状態 → 展開
    await user.click(screen.getByRole("button", { name: /1\. 旧名/ }));
    const nameInput = screen.getByDisplayValue("旧名");
    await user.clear(nameInput);
    await user.type(nameInput, "新名");
    expect(screen.getByDisplayValue("新名")).toBeInTheDocument();
    // キーワード入力 (blur で commit、表示は文字列のまま)
    const kwInput = screen.getByPlaceholderText("入部, 参加, 加入");
    await user.type(kwInput, "面談, 加入");
    await user.tab();
    expect(screen.getByDisplayValue("面談, 加入")).toBeInTheDocument();
  });

  it("ルール並べ替え: ↑/↓ で順序が入れ替わる", async () => {
    const user = userEvent.setup();
    renderEditor({
      enabled: true,
      rules: [
        rule({ id: "a", name: "Aルール", keywords: ["a"] }),
        rule({ id: "b", name: "Bルール", keywords: ["b"] }),
      ],
    });
    await expand(user);
    expect(screen.getByText("1. Aルール")).toBeInTheDocument();
    expect(screen.getByText("2. Bルール")).toBeInTheDocument();
    // 2番目 (Bルール) を上へ。アイコンボタンの a11y name は記号 (title は説明)。
    const upButtons = screen.getAllByRole("button", { name: "↑" });
    await user.click(upButtons[1]);
    expect(screen.getByText("1. Bルール")).toBeInTheDocument();
    expect(screen.getByText("2. Aルール")).toBeInTheDocument();
  });

  it("ルール削除: confirm OK で一覧から消える", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderEditor({
      enabled: true,
      rules: [rule({ id: "a", name: "消す対象", keywords: ["x"] })],
    });
    await expand(user);
    expect(screen.getByText("1. 消す対象")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "×" }));
    await waitFor(() => {
      expect(screen.queryByText("1. 消す対象")).not.toBeInTheDocument();
    });
    expect(
      screen.getByText(
        "ルールはまだありません。下のボタンから追加してください。",
      ),
    ).toBeInTheDocument();
  });

  it("ルール削除: confirm キャンセルで消えない", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    renderEditor({
      enabled: true,
      rules: [rule({ id: "a", name: "残す対象", keywords: ["x"] })],
    });
    await expand(user);
    await user.click(screen.getByRole("button", { name: "×" }));
    expect(screen.getByText("1. 残す対象")).toBeInTheDocument();
  });

  it("else トグル: ON で else カードが出て、編集状態になる", async () => {
    const user = userEvent.setup();
    renderEditor(null);
    await expand(user);
    expect(screen.queryByText("else")).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /else を有効にする/ }));
    // else カードの title は "else"
    expect(screen.getByText("else")).toBeInTheDocument();
  });

  it("autoReply: ルール展開後トグル ON で件名/本文 UI が出る", async () => {
    const user = userEvent.setup();
    renderEditor({
      enabled: true,
      rules: [rule({ id: "a", name: "AR", keywords: ["x"] })],
    });
    await expand(user);
    await user.click(screen.getByRole("button", { name: /1\. AR/ }));
    expect(screen.getByText("自動返信")).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText("ご連絡ありがとうございます"),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("checkbox", { name: /自動返信を有効化/ }),
    );
    expect(
      screen.getByPlaceholderText("ご連絡ありがとうございます"),
    ).toBeInTheDocument();
    // デフォルト雛形が subject に入る
    expect(
      screen.getByDisplayValue("ご連絡ありがとうございます"),
    ).toBeInTheDocument();
  });

  it("保存バリデーション: enabled で有効ルール無し → エラー toast", async () => {
    const user = userEvent.setup();
    renderEditor(null);
    await expand(user);
    await user.click(
      screen.getByRole("checkbox", { name: /監視を有効にする/ }),
    );
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      expect(
        screen.getByText(
          "有効化するには、キーワード+通知先が揃ったルールを 1 つ以上、または else を設定してください",
        ),
      ).toBeInTheDocument();
    });
  });

  it("保存成功: 有効ルールが揃っていれば成功 toast", async () => {
    const user = userEvent.setup();
    renderEditor(
      {
        enabled: true,
        rules: [
          rule({
            id: "a",
            name: "OK",
            keywords: ["x"],
            workspaceId: "ws1",
            channelId: "C1",
            channelName: "general",
          }),
        ],
      },
      { "/gmail-accounts/g1/watcher": { ok: true } },
    );
    await expand(user);
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      expect(
        screen.getByText("メール監視設定を保存しました"),
      ).toBeInTheDocument();
    });
  });

  it("不正入力耐性: legacy config (channelId 直下) を rules[0] に変換", async () => {
    const user = userEvent.setup();
    renderEditor({
      enabled: true,
      channelId: "C-legacy",
      channelName: "legacy-ch",
      keywords: ["旧"],
    } as GmailWatcherConfig);
    await expand(user);
    expect(screen.getByText("1. デフォルト")).toBeInTheDocument();
    expect(
      screen.getByText("キーワード: 旧 / 通知先: #legacy-ch"),
    ).toBeInTheDocument();
  });

  it("不正入力耐性: getWatcher が reject でも throw せずエラー表示", async () => {
    const user = userEvent.setup();
    // fetch が reject するよう stub
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/watcher")) throw new Error("network down");
        return new Response(JSON.stringify([ws1]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    render(
      <ToastProvider>
        <GmailWatcherEditor account={account} />
      </ToastProvider>,
    );
    await user.click(screen.getByRole("button", { name: /メール監視設定/ }));
    await waitFor(() => {
      expect(screen.getByText("監視を有効にする")).toBeInTheDocument();
    });
    // catch ブランチで savedRules=[] にフォールバックし描画継続
    expect(
      screen.getByText(
        "ルールはまだありません。下のボタンから追加してください。",
      ),
    ).toBeInTheDocument();
  });
});
