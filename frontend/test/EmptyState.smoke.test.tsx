import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EmptyState } from "../src/components/EmptyState";

// UX 改善 Phase 1 - PR2 (J): EmptyState の最小スモーク。
//
// 確認項目:
//   - title / description / icon が出る
//   - primary / secondary action ボタンが描画され、click で onClick が呼ばれる
//   - aria-current 等の attribute はテスト対象外 (Breadcrumbs.test 側で担保)

function installMatchMediaMock(matches: boolean) {
  const mql = {
    matches,
    media: "",
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  };
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn(() => mql),
  });
}

describe("EmptyState", () => {
  afterEach(() => {
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  });

  it("title / description / icon / 両 CTA を描画し、クリックでハンドラが呼ばれる", async () => {
    installMatchMediaMock(false);
    const onPrimary = vi.fn();
    const onSecondary = vi.fn();
    render(
      <EmptyState
        icon="📭"
        title="まだメンバーが登録されていません"
        description="参加届を提出した人を取り込むか、手動で追加してください。"
        primaryAction={{ label: "＋ メンバー追加", onClick: onPrimary }}
        secondaryAction={{
          label: "参加届から取り込み",
          onClick: onSecondary,
        }}
      />,
    );
    // heading / description / icon
    expect(
      screen.getByRole("heading", { name: /まだメンバーが登録されていません/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/参加届を提出した人を取り込むか/),
    ).toBeInTheDocument();
    expect(screen.getByText("📭")).toBeInTheDocument();
    // primary
    const primary = screen.getByRole("button", { name: /メンバー追加/ });
    await userEvent.click(primary);
    expect(onPrimary).toHaveBeenCalledTimes(1);
    // secondary
    const secondary = screen.getByRole("button", { name: /参加届から取り込み/ });
    await userEvent.click(secondary);
    expect(onSecondary).toHaveBeenCalledTimes(1);
  });

  it("primary/secondary を省略すると button は描画されない", () => {
    installMatchMediaMock(false);
    render(<EmptyState title="空です" />);
    expect(screen.getByRole("heading", { name: "空です" })).toBeInTheDocument();
    // ボタンが何も出ない
    expect(screen.queryByRole("button")).toBeNull();
  });
});
