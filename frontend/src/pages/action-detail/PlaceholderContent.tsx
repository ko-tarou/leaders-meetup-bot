import { colors } from "../../styles/tokens";

// Phase4-3: ActionDetailPage から純抽出。マークアップ・スタイル不変。
export function PlaceholderContent({ label }: { label: string }) {
  return (
    <div
      style={{ padding: "2rem", textAlign: "center", color: colors.textSecondary }}
    >
      {label}
    </div>
  );
}
