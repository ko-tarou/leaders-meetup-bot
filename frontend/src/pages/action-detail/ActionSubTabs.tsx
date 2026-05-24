import { colors } from "../../styles/tokens";
import type { SubTabDef } from "./subTabs";
import { subTabBtn } from "./styles";

// Phase4-3: ActionDetailPage のサブタブバーを純抽出。
// subTabs が空 (weekly_reminder) のときは描画しない条件も不変。
//
// レスポンシブ対応 PR1: サブタブが多い (member_application は最大 5+ 個) ため
// モバイルでは横スクロールできるよう overflow-x: auto に切り替える。
// flex-wrap させると 2 行になり選択中タブの位置が分かりにくくなる。
export function ActionSubTabs({
  subTabs,
  subTab,
  onSelect,
}: {
  subTabs: SubTabDef[];
  subTab: string;
  onSelect: (id: string) => void;
}) {
  if (subTabs.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        gap: "0.25rem",
        borderBottom: `1px solid ${colors.border}`,
        marginBottom: "1rem",
        // モバイルでも 1 行で並べ、はみ出した分は横スクロールさせる。
        overflowX: "auto",
        WebkitOverflowScrolling: "touch",
      }}
    >
      {subTabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onSelect(t.id)}
          style={{
            ...subTabBtn(subTab === t.id),
            // 横スクロール領域内では shrink を抑制してタブ毎の最小幅を確保
            flex: "0 0 auto",
            whiteSpace: "nowrap",
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
