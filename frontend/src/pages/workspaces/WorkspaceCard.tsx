// Phase4-7 純抽出: WorkspacesPage の workspace 一覧 1 行を子コンポーネント化。
// データ所有は親 (workspaces / bulkInviteLoading)、本コンポーネントは描画と
// クリック委譲のみ。マークアップ・style・disabled 条件は一字一句不変。
import type { Workspace } from "../../types";
import { colors } from "../../styles/tokens";

export function WorkspaceCard({
  ws,
  isReadOnly,
  bulkInviteLoading,
  onBulkInvite,
  onDelete,
}: {
  ws: Workspace;
  isReadOnly: boolean;
  bulkInviteLoading: string | null;
  onBulkInvite: (ws: Workspace) => void;
  onDelete: (ws: Workspace) => void;
}) {
  return (
    <div
      style={{
        border: `1px solid ${colors.border}`,
        borderRadius: "0.375rem",
        padding: "0.75rem",
        marginBottom: "0.5rem",
        display: "flex",
        alignItems: "center",
      }}
    >
      <div style={{ flex: 1 }}>
        <strong>{ws.name}</strong>
        <div style={{ fontSize: "0.75rem", color: colors.textSecondary }}>
          team_id: {ws.slackTeamId} / 登録日: {ws.createdAt.slice(0, 10)}
        </div>
      </div>
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
        <button
          onClick={() => onBulkInvite(ws)}
          disabled={isReadOnly || bulkInviteLoading === ws.id}
          style={{
            background: colors.primary,
            color: colors.textInverse,
            border: "none",
            padding: "0.375rem 0.75rem",
            borderRadius: "0.25rem",
            cursor:
              isReadOnly || bulkInviteLoading === ws.id
                ? "not-allowed"
                : "pointer",
            fontSize: "0.875rem",
          }}
          title="このワークスペースの全 channel に bot を一括招待します"
        >
          {bulkInviteLoading === ws.id ? "招待中..." : "bot を一括招待"}
        </button>
        <button
          onClick={() => onDelete(ws)}
          style={{ background: colors.danger, color: colors.textInverse }}
          disabled={ws.id === "ws_default"}
          title={
            ws.id === "ws_default"
              ? "default workspace は削除できません"
              : ""
          }
        >
          削除
        </button>
      </div>
    </div>
  );
}
