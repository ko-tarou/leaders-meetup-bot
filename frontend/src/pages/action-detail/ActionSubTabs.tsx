import { colors } from "../../styles/tokens";
import type { SubTabDef } from "./subTabs";
import { subTabBtn } from "./styles";

// Phase4-3: ActionDetailPage のサブタブバーを純抽出。
// subTabs が空 (weekly_reminder) のときは描画しない条件も不変。
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
      }}
    >
      {subTabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onSelect(t.id)}
          style={subTabBtn(subTab === t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
