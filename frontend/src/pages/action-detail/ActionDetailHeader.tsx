import { Link } from "react-router-dom";
import type { EventAction, EventActionType } from "../../types";
import { ACTION_META } from "../../lib/eventTabs";
import { useIsMobile } from "../../hooks/useIsMobile";
import { Breadcrumbs } from "../../components/Breadcrumbs";
import { colors } from "../../styles/tokens";

// Phase4-3: ActionDetailPage のヘッダ部 (パンくず / タイトル / 無効バッジ /
// 一覧に戻るリンク / 説明文) を純抽出。マークアップ・スタイルすべて不変。
//
// UX 改善 Phase 1 - PR2 (B): 旧インライン breadcrumb を共通 <Breadcrumbs />
// に置き換え。aria-label / mobile 省略表示などのアクセシビリティを底上げする。
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
  const isMobile = useIsMobile();
  const meta = ACTION_META[actionType as EventActionType];
  return (
    <>
      <Breadcrumbs
        items={[
          { label: "ホーム", href: "/" },
          {
            label: eventName ?? "イベント",
            href: `/events/${eventId}/actions`,
          },
          { label: meta?.label ?? actionType },
        ]}
      />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          marginBottom: "0.5rem",
          flexWrap: "wrap",
          gap: "0.5rem",
        }}
      >
        <h2 style={{ margin: 0, fontSize: isMobile ? "1.15rem" : "1.3rem" }}>
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
            // mobile では auto を使わず flexWrap で改行されるのに任せて
            // 「一覧に戻る」が独立行に落ちるようにする
            marginLeft: isMobile ? 0 : "auto",
            color: colors.primary,
            textDecoration: "none",
            fontSize: "0.875rem",
            // mobile では行頭に来てもよいようフル幅化
            flexBasis: isMobile ? "100%" : undefined,
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
