import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  AutoClassifyTab,
  computeAutoAssignPlan,
} from "../src/components/role-management/AutoClassifyTab";
import type { EventAction, RoleCategory } from "../src/types";
import { ToastProvider } from "../src/components/ui/Toast";
import { ConfirmProvider } from "../src/components/ui/ConfirmDialog";

// 自動分類タブ「自動割り当てを適用」のフィードバック回帰。
// 本人フィードバック「押しても動いてるのか分からない」への対策を固定する:
//   - 押下 -> 結果バナー (成功: 割当件数 + カテゴリ内訳 + 既存/要確認スキップ)
//   - 対象 0 人でも「追加した人はいませんでした」と理由を明示
//   - addMembers が正しい targets で呼ばれる (= ロールへ反映される)

const EVENT_ID = "ev1";
const ACTION_ID = "act-role";

function makeAction(): EventAction {
  return {
    id: ACTION_ID,
    eventId: EVENT_ID,
    actionType: "role_management",
    config: JSON.stringify({ workspaceId: "ws1" }),
    enabled: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

// 4 カテゴリ root ロール (name 一致で解決される)。
const ROLES = [
  { id: "r-participant", name: "参加者", parentRoleId: null },
  { id: "r-staff", name: "運営", parentRoleId: null },
  { id: "r-sponsor", name: "スポンサー", parentRoleId: null },
  { id: "r-judge", name: "審査員", parentRoleId: null },
].map((r) => ({
  ...r,
  description: null,
  membersCount: 0,
  channelsCount: 0,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
}));

// classify-preview: U1 運営(名簿一致) / U2 運営(要確認=名簿なし) /
// U3 参加者 / U4 運営(既に割当済み) / U5 未分類。
const PREVIEW = {
  workspaceId: "ws1",
  rosterActionFound: true,
  summary: {
    total: 5,
    byCategory: { participant: 1, staff: 3, sponsor: 0, judge: 0 },
    unclassified: 1,
    needsReview: 1,
  },
  members: [
    { id: "U1", displayName: "(運営)一致", category: "staff", categoryLabel: "運営", matchedLabel: "運営", inRoster: true, needsReview: false },
    { id: "U2", displayName: "(運営)詐称", category: "staff", categoryLabel: "運営", matchedLabel: "運営", inRoster: false, needsReview: true },
    { id: "U3", displayName: "(参加者)花子", category: "participant", categoryLabel: "参加者", matchedLabel: "参加者", inRoster: false, needsReview: false },
    { id: "U4", displayName: "(運営)既存", category: "staff", categoryLabel: "運営", matchedLabel: "運営", inRoster: true, needsReview: false },
    { id: "U5", displayName: "名無し", category: null, categoryLabel: null, matchedLabel: null, inRoster: false, needsReview: false },
  ],
};

type Call = { url: string; method: string; body?: string };

function installFetch(
  rolesList: typeof ROLES = ROLES,
  preview: typeof PREVIEW = PREVIEW,
): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
      const method = init?.method ?? "GET";
      const body = init?.body == null ? undefined : String(init.body);
      calls.push({ url, method, body });
      const path = url.split("?")[0];
      const json = (v: unknown) =>
        new Response(JSON.stringify(v), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });

      if (path.endsWith("/classify-preview")) return json(preview);
      // getMembers: 運営ロールに U4 が既に居る。他は空。
      const mMembers = path.match(/\/roles\/([^/]+)\/members$/);
      if (mMembers && method === "GET") {
        const roleId = mMembers[1];
        const rows =
          roleId === "r-staff" ? [{ slackUserId: "U4", addedAt: "x" }] : [];
        return json(rows);
      }
      if (mMembers && method === "POST") return json({ ok: true, added: 1 });
      if (path.endsWith("/roles")) return json(rolesList);
      return json([]);
    }),
  );
  return calls;
}

function renderTab() {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <AutoClassifyTab eventId={EVENT_ID} action={makeAction()} />
      </ConfirmProvider>
    </ToastProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("computeAutoAssignPlan", () => {
  it("gated 要確認は除外・既存はスキップ・件数を返す", () => {
    const membership: Record<RoleCategory, Set<string>> = {
      participant: new Set(),
      staff: new Set(["U4"]),
      sponsor: new Set(),
      judge: new Set(),
    };
    const plan = computeAutoAssignPlan(
      PREVIEW.members as never,
      membership,
    );
    expect(plan.perCategory.staff).toEqual(["U1"]); // U2要確認除外, U4既存
    expect(plan.perCategory.participant).toEqual(["U3"]);
    expect(plan.added).toBe(2);
    expect(plan.skippedReview).toBe(1);
    expect(plan.skippedExisting).toBe(1);
    expect(plan.classifiedTotal).toBe(4);
  });
});

describe("AutoClassifyTab 自動割り当てのフィードバック", () => {
  it("押下で結果バナー (割当件数+内訳+スキップ理由) を出し addMembers を呼ぶ", async () => {
    const calls = installFetch();
    renderTab();

    // 抽出テーブルの描画を待つ。
    await waitFor(() =>
      expect(screen.getByTestId("auto-classify-tab")).toBeInTheDocument(),
    );
    const applyBtn = await screen.findByTestId("apply-auto-btn");
    await userEvent.click(applyBtn);

    // 永続バナーで成功と内訳を明示する。
    const banner = await screen.findByTestId("apply-result");
    await waitFor(() =>
      expect(banner).toHaveTextContent("2 人に割り当てました"),
    );
    expect(banner).toHaveTextContent("運営 1");
    expect(banner).toHaveTextContent("参加者 1");
    expect(banner).toHaveTextContent("要確認 1 人");
    expect(banner).toHaveTextContent("既存 1 人");

    // 実際に addMembers (POST /roles/<id>/members) が正しい targets で呼ばれる。
    const posts = calls.filter(
      (c) => c.method === "POST" && /\/roles\/[^/]+\/members$/.test(c.url),
    );
    const staffPost = posts.find((c) => c.url.includes("/roles/r-staff/"));
    const partPost = posts.find((c) => c.url.includes("/roles/r-participant/"));
    expect(staffPost?.body).toContain("U1");
    expect(staffPost?.body).not.toContain("U2"); // 要確認は送らない
    expect(partPost?.body).toContain("U3");
  });

  it("ロール未初期化 (運営のみ) で押すと無反応でなく明示バナーを出す (HackIt2026 再現)", async () => {
    // HackIt2026 の状態: 4 カテゴリのうち「運営」しか存在しない。
    const onlyStaff = ROLES.filter((r) => r.name === "運営");
    const calls = installFetch(onlyStaff);
    renderTab();

    const applyBtn = await screen.findByTestId("apply-auto-btn");
    // 旧実装のように disabled で無反応にしない。
    expect(applyBtn).not.toBeDisabled();
    await userEvent.click(applyBtn);

    // 明示のエラーバナーで「未初期化 → 初期化してください」を案内する。
    const banner = await screen.findByTestId("apply-result");
    expect(banner).toHaveTextContent("未初期化");
    expect(banner).toHaveTextContent("ロールを初期化");

    // 未初期化なので addMembers は 1 度も呼ばない。
    const posts = calls.filter(
      (c) => c.method === "POST" && /\/roles\/[^/]+\/members$/.test(c.url),
    );
    expect(posts.length).toBe(0);
  });

  it("HackIT2026相当(名簿空で全員要確認): 0件の内訳を明示し要確認まとめ追加で救済", async () => {
    // 抽出はあるが全 staff が needsReview (名簿0件) + 未分類あり = 0件追加の実態。
    const preview = {
      workspaceId: "ws1",
      rosterActionFound: true,
      summary: {
        total: 3,
        byCategory: { participant: 0, staff: 2, sponsor: 0, judge: 0 },
        unclassified: 1,
        needsReview: 2,
      },
      members: [
        { id: "S1", displayName: "(運営)甲", category: "staff", categoryLabel: "運営", matchedLabel: "運営", inRoster: false, needsReview: true },
        { id: "S2", displayName: "(運営)乙", category: "staff", categoryLabel: "運営", matchedLabel: "運営", inRoster: false, needsReview: true },
        { id: "P1", displayName: "名無し", category: null, categoryLabel: null, matchedLabel: null, inRoster: false, needsReview: false },
      ],
    } as typeof PREVIEW;
    const calls = installFetch(ROLES, preview);
    renderTab();

    // 「自動割り当てを適用」= gated 全除外で 0 件。内訳バナーを出す。
    await userEvent.click(await screen.findByTestId("apply-auto-btn"));
    const banner = await screen.findByTestId("apply-result");
    expect(banner).toHaveTextContent("追加した人はいませんでした");
    expect(banner).toHaveTextContent("要確認除外 2");
    expect(banner).toHaveTextContent("未分類 1");

    // 「要確認 2 人をまとめて追加」で救済 (確認ダイアログ承認)。
    await userEvent.click(screen.getByTestId("assign-review-btn"));
    await userEvent.click(await screen.findByRole("button", { name: "2 人を追加" }));

    // 救済後は成功バナー (added>0) に切り替わり、運営に 2 人反映。
    await waitFor(() =>
      expect(screen.getByTestId("apply-result")).toHaveTextContent(
        "2 人に割り当てました",
      ),
    );
    expect(screen.getByTestId("apply-result")).toHaveTextContent("運営 2");
    const staffPost = calls.find(
      (c) => c.method === "POST" && c.url.includes("/roles/r-staff/"),
    );
    expect(staffPost?.body).toContain("S1");
    expect(staffPost?.body).toContain("S2");
  });
});
