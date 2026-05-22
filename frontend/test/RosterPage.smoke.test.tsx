import { describe, it, expect, vi } from "vitest";
import { render as rtlRender, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RosterPage } from "../src/pages/roster/RosterPage";
import type { RosterCustomColumn, RosterMember } from "../src/types";
import { AppProviders, renderWithProviders } from "./util";

// 名簿管理 (member_roster) PR3-FE: RosterPage の read-only スモーク。
// util.tsx の installFetchMock は path.endsWith(key) で routing する。
// クエリ文字列は取り除いた上でマッチするため、includeInactive=1 も同 path に解決される。

const ACTION_ID = "act-roster-1";
const EVENT_ID = "ev-1";
// hotfix: roster API パスは `/orgs/:eventId/actions/:actionId/roster/...`
// に移行済み。テストも新パスに合わせる (BE は旧パスも残しているが、
// FE クライアントは新パスを叩く)。
const ROUTE = `/orgs/${EVENT_ID}/actions/${ACTION_ID}/roster/members`;

function makeMember(over: Partial<RosterMember>): RosterMember {
  return {
    id: crypto.randomUUID(),
    eventActionId: ACTION_ID,
    name: "Alice",
    nameKana: "アリス",
    email: "alice@example.com",
    grade: "B3",
    slackUserId: null,
    slackName: "alice",
    joinedAt: "2025-04-01",
    leftAt: null,
    note: null,
    status: "active",
    createdAt: "2025-04-01T00:00:00Z",
    updatedAt: "2025-04-01T00:00:00Z",
    deletedAt: null,
    ...over,
  };
}

const members: RosterMember[] = [
  makeMember({ name: "Alice", nameKana: "アリス", grade: "B3" }),
  makeMember({ name: "Bob", nameKana: "ボブ", grade: "M1", email: "bob@x.com" }),
  makeMember({
    name: "Charlie",
    nameKana: "チャーリー",
    grade: "B4",
    status: "inactive",
  }),
];

function render(rows: RosterMember[] = members) {
  return renderWithProviders(<RosterPage eventId="ev-1" actionId={ACTION_ID} />, {
    routes: { [ROUTE]: rows },
  });
}

describe("RosterPage smoke", () => {
  it("一覧の行 (active) が表示される", async () => {
    render();
    expect(await screen.findByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
  });

  it("空配列のとき空状態メッセージが出る", async () => {
    render([]);
    await waitFor(() => {
      expect(
        screen.getByText(/まだメンバーが登録されていません/),
      ).toBeInTheDocument();
    });
  });

  it("検索ボックスで name / kana / email を絞り込める", async () => {
    render();
    await screen.findByText("Alice");
    const input = screen.getByLabelText("名簿を検索");
    await userEvent.type(input, "bob");
    await waitFor(() => {
      expect(screen.queryByText("Alice")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Bob")).toBeInTheDocument();
  });

  it("退会済み非表示トグルを外すと inactive 行が増える", async () => {
    // BE のクエリ挙動をエミュレートする: includeInactive=1 のみ Charlie を返す。
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        const body = url.includes("includeInactive=1")
          ? members
          : members.filter((m) => m.status === "active");
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    rtlRender(
      <AppProviders>
        <RosterPage eventId="ev-1" actionId={ACTION_ID} />
      </AppProviders>,
    );
    await screen.findByText("Alice");
    expect(screen.queryByText("Charlie")).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("退会済みを非表示"));
    await waitFor(() => {
      expect(screen.getByText("Charlie")).toBeInTheDocument();
    });
  });

  it("列ヘッダをクリックするとソート方向の矢印が出る", async () => {
    render();
    await screen.findByText("Alice");
    const btn = screen.getByRole("button", { name: /名前 で並び替え/ });
    await userEvent.click(btn);
    // active なヘッダには ▲ か ▼ が出る
    await waitFor(() => {
      const arrows = screen.getAllByText(/[▲▼]/);
      expect(arrows.length).toBeGreaterThan(0);
    });
  });

  it("status='active' のメンバーは「在籍」バッジが付く", async () => {
    render();
    await screen.findByText("Alice");
    // active 2 名 + (デフォルトでは inactive 除外) → 「在籍」が 2 個
    const badges = screen.getAllByText("在籍");
    expect(badges.length).toBeGreaterThanOrEqual(2);
  });

  // PR6: 取り込み / 追加ボタンが描画され、押下でモーダルが開く。
  it("「合格者から取り込み」ボタンと「+ メンバー追加」ボタンが表示される (PR6)", async () => {
    render();
    await screen.findByText("Alice");
    expect(screen.getByRole("button", { name: /合格者から取り込み/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /メンバー追加/ })).toBeInTheDocument();
  });

  it("「+ メンバー追加」ボタン押下でモーダルが開く (PR6)", async () => {
    render();
    await screen.findByText("Alice");
    await userEvent.click(screen.getByRole("button", { name: /メンバー追加/ }));
    expect(await screen.findByRole("dialog", { name: "メンバー追加" })).toBeInTheDocument();
  });

  // PR5b: カスタム列ヘッダとセル値が一覧表に出る。util の route map (path.endsWith) で 3 種を分岐。
  it("カスタム列の見出しと値が一覧表に表示される (PR5b)", async () => {
    const aliceId = members[0]!.id;
    const cols: RosterCustomColumn[] = [{
      id: "col-1", eventActionId: ACTION_ID, columnKey: "size", label: "サイズ",
      type: "select", optionsJson: JSON.stringify(["S", "M", "L"]), sortOrder: 0,
      createdAt: "x", updatedAt: "x",
    }];
    renderWithProviders(<RosterPage eventId="ev-1" actionId={ACTION_ID} />, {
      routes: {
        [ROUTE]: members,
        [`/orgs/${EVENT_ID}/actions/${ACTION_ID}/roster/columns`]: cols,
        [`/orgs/${EVENT_ID}/actions/${ACTION_ID}/roster/values`]: [
          { memberId: aliceId, columnId: "col-1", valueJson: JSON.stringify("M") },
        ],
      },
    });
    expect(await screen.findByText("サイズ")).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText("M").length).toBeGreaterThan(0));
  });
});
