import { Link } from "react-router-dom";
import type { EventAction, EventActionType } from "../../types";
import { ACTION_META } from "../../lib/eventTabs";
import { colors } from "../../styles/tokens";
import { breadcrumbLinkStyle } from "./styles";

// Phase4-3: ActionDetailPage のヘッダ部 (パンくず / タイトル / 無効バッジ /
// 一覧に戻るリンク / 説明文) を純抽出。マークアップ・スタイルすべて不変。
export function ActionDetailHeader({
  eventId,
  actionType,
  action,
  eventName,
}: {
  eventId: string;
  actionType: string;
  action: EventAction;
  eventName: string | undefined;
}) {
  const meta = ACTION_META[actionType as EventActionType];
  return (
    <>
      {/* パンくずリスト */}
      <div
        style={{
          fontSize: "0.875rem",
          marginBottom: "0.5rem",
          color: colors.textSecondary,
        }}
      >
        <Link to="/" style={breadcrumbLinkStyle}>
          ホーム
        </Link>
        {" › "}
        <Link
          to={`/events/${eventId}/actions`}
          style={breadcrumbLinkStyle}
        >
          {eventName ?? "イベント"}
        </Link>
        {" › "}
        <span>{meta?.label ?? actionType}</span>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          marginBottom: "0.5rem",
          flexWrap: "wrap",
          gap: "0.5rem",
        }}
      >
        <h2 style={{ margin: 0, fontSize: "1.3rem" }}>
          {meta?.icon} {meta?.label ?? actionType}
        </h2>
        {action.enabled !== 1 && (
          <span
            style={{
              fontSize: "0.75rem",
              padding: "0.125rem 0.5rem",
              borderRadius: "0.25rem",
              background: colors.textMuted,
              color: colors.textInverse,
            }}
          >
            無効
          </span>
        )}
        <Link
          to={`/events/${eventId}/actions`}
          style={{
            marginLeft: "auto",
            color: colors.primary,
            textDecoration: "none",
            fontSize: "0.875rem",
          }}
        >
          ← 一覧に戻る
        </Link>
      </div>

      {meta?.description && (
        <p
          style={{
            fontSize: "0.875rem",
            color: colors.textSecondary,
            marginTop: 0,
            marginBottom: "1rem",
          }}
        >
          {meta.description}
        </p>
      )}
    </>
  );
}
