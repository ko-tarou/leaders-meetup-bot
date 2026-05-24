// Phase4-7 純抽出: WorkspacesPage の workspace 一覧 1 行を子コンポーネント化。
// データ所有は親 (workspaces / bulkInviteLoading)、本コンポーネントは描画と
// クリック委譲のみ。
//
// レスポンシブ対応 PR1: 横幅が狭い (mobile) 時は本文 + ボタン列を
// 縦並びにし、ボタン群を 2 列の grid で折り返す。
import type { Workspace } from "../../types";
import { colors } from "../../styles/tokens";
import { useIsMobile } from "../../hooks/useIsMobile";

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
  const isMobile = useIsMobile();
  return (
    <div
      style={{
        border: `1px solid ${colors.border}`,
        borderRadius: "0.375rem",
        padding: "0.75rem",
        marginBottom: "0.5rem",
        display: "flex",
        flexDirection: isMobile ? "column" : "row",
        alignItems: isMobile ? "stretch" : "center",
        gap: isMobile ? "0.5rem" : 0,
      }}
    >
      <div style={{ flex: 1, minWidth: 0, wordBreak: "break-word" }}>
        <strong>{ws.name}</strong>
        <div style={{ fontSize: "0.75rem", color: colors.textSecondary }}>
          team_id: {ws.slackTeamId} / 登録日: {ws.createdAt.slice(0, 10)}
        </div>
      </div>
      <div
        style={{
          display: "flex",
          gap: "0.5rem",
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <button
          onClick={() => onBulkInvite(ws)}
          disabled={isReadOnly || bulkInviteLoading === ws.id}
          style={{
            background: colors.primary,
            color: colors.textInverse,
            border: "none",
            padding: "0.5rem 0.75rem",
            borderRadius: "0.25rem",
            cursor:
              isReadOnly || bulkInviteLoading === ws.id
                ? "not-allowed"
                : "pointer",
            fontSize: "0.875rem",
            minHeight: 36,
            flex: isMobile ? "1 1 auto" : undefined,
          }}
          title="このワークスペースの全 channel に bot を一括招待します"
        >
          {bulkInviteLoading === ws.id ? "招待中..." : "bot を一括招待"}
        </button>
        <button
          onClick={() => onDelete(ws)}
          style={{
            background: colors.danger,
            color: colors.textInverse,
            minHeight: 36,
          }}
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
