import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { EventAction, EventActionType } from "../types";
import { api } from "../api";
import { ACTION_META } from "../lib/eventTabs";
import { EmptyState } from "./EmptyState";
import { useToast } from "./ui/Toast";
import { colors } from "../styles/tokens";
import { useIsMobile } from "../hooks/useIsMobile";

// Sprint 13 PR1: アクション一覧 (カード形式)。
// クリックで /events/:eventId/actions/:actionType の専用ページへ遷移する。
// 追加導線は AddActionModal (旧 ActionsTab.tsx 由来) をそのまま流用。
//
// members-tab-integration (2026-05): 「メンバー」タブで 名簿 + ロール管理 を
// 一元化したため、ALL_ACTION_TYPES からは "member_roster" / "role_management"
// を除外する (「+ 新規追加」モーダルの選択肢に出さない)。
// 既に作成済の action 行も「アクション一覧」カードからは隠す
// (メンバータブから引き続きアクセス可能 + 互換のため ActionDetailPage は維持)。
const HIDDEN_FROM_LIST: EventActionType[] = [
  "member_roster",
  "role_management",
];

const ALL_ACTION_TYPES: EventActionType[] = [
  "schedule_polling",
  "task_management",
  "member_welcome",
  "pr_review_list",
  "weekly_reminder",
  "attendance_check",
  "sponsor_application",
  // stale-pr-nudge: 登録すると PR レビュー一覧に「📣 リマインド送信」ボタンが出る。
  // 設定 (監視 repo / 催促チャンネル) は登録後に「設定」タブで埋める。
  "stale_pr_nudge",
  // app_management: イベント連動アプリの表示コンテンツ管理 (エディタリンク集)。
  "app_management",
];

type Props = {
  eventId: string;
  actions: EventAction[];
  onChange: () => void; // 追加後に親で再取得する
};

export function ActionsListView({ eventId, actions, onChange }: Props) {
  const navigate = useNavigate();
  const [showAdd, setShowAdd] = useState(false);

  // members-tab-integration: 一覧表示からは member_roster / role_management を除外。
  // これらは「メンバー」タブで一元管理する (互換のため /actions/:type 直リンクは生きている)。
  const visibleActions = actions.filter(
    (a) => !HIDDEN_FROM_LIST.includes(a.actionType),
  );
  const usedTypes = new Set(actions.map((a) => a.actionType));
  const availableTypes = ALL_ACTION_TYPES.filter((t) => !usedTypes.has(t));

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          marginBottom: "1rem",
        }}
      >
        <h3 style={{ margin: 0, fontSize: "1.05rem" }}>
          アクション一覧 ({visibleActions.length}件)
        </h3>
        {availableTypes.length > 0 && (
          <button
            onClick={() => setShowAdd(true)}
            style={{ ...primaryBtnStyle, marginLeft: "auto" }}
          >
            + 新規追加
          </button>
        )}
      </div>

      {visibleActions.length === 0 ? (
        <EmptyState
          icon="📦"
          title="アクションが登録されていません"
          description="日程調整・タスク管理・週次リマインドなど、このイベントで使いたい機能を追加してください。"
          primaryAction={
            availableTypes.length > 0
              ? {
                  label: "＋ 新規追加",
                  onClick: () => setShowAdd(true),
                }
              : undefined
          }
        />
      ) : (
        <div style={{ display: "grid", gap: "0.75rem" }}>
          {visibleActions.map((a) => {
            const meta = ACTION_META[a.actionType];
            return (
              <div
                key={a.id}
                role="button"
                tabIndex={0}
                onClick={() =>
                  navigate(
                    `/events/${eventId}/actions/${a.actionType}`,
                  )
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    navigate(
                      `/events/${eventId}/actions/${a.actionType}`,
                    );
                  }
                }}
                style={{
                  padding: "1rem",
                  border: `1px solid ${colors.border}`,
                  borderRadius: "0.5rem",
                  cursor: "pointer",
                  background: colors.background,
                  opacity: a.enabled === 1 ? 1 : 0.6,
                  transition: "background 0.15s, border-color 0.15s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = colors.surface;
                  e.currentTarget.style.borderColor = colors.textMuted;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = colors.background;
                  e.currentTarget.style.borderColor = colors.border;
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.5rem",
                  }}
                >
                  <span style={{ fontSize: "1.5rem" }}>
                    {meta?.icon ?? "📦"}
                  </span>
                  <strong style={{ fontSize: "1.05rem" }}>
                    {meta?.label ?? a.actionType}
                  </strong>
                  {a.enabled !== 1 && (
                    <span
                      style={{
                        marginLeft: "auto",
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
                </div>
                <div
                  style={{
                    marginTop: "0.5rem",
                    fontSize: "0.875rem",
                    color: colors.textSecondary,
                  }}
                >
                  {meta?.description ?? ""}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showAdd && (
        <AddActionModal
          eventId={eventId}
          availableTypes={availableTypes}
          onClose={() => setShowAdd(false)}
          onAdded={() => {
            setShowAdd(false);
            onChange();
          }}
        />
      )}
    </div>
  );
}

function AddActionModal({
  eventId,
  availableTypes,
  onClose,
  onAdded,
}: {
  eventId: string;
  availableTypes: EventActionType[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const toast = useToast();
  const isMobile = useIsMobile();
  const [actionType, setActionType] = useState<EventActionType>(
    availableTypes[0],
  );
  const [submitting, setSubmitting] = useState(false);

  const handleAdd = async () => {
    setSubmitting(true);
    try {
      await api.events.actions.create(eventId, {
        actionType,
        config: "{}",
        enabled: 1,
      });
      onAdded();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "追加に失敗しました");
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: isMobile ? "stretch" : "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "white",
          padding: isMobile ? "1rem" : "1.5rem",
          borderRadius: isMobile ? 0 : "0.5rem",
          width: isMobile ? "100%" : "min(400px, 90vw)",
          maxHeight: isMobile ? "100vh" : "90vh",
          overflow: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0 }}>アクション追加</h3>
        <label
          style={{
            display: "block",
            fontSize: "0.875rem",
            marginBottom: "0.25rem",
            color: colors.text,
          }}
        >
          アクション種別
        </label>
        <select
          value={actionType}
          onChange={(e) => setActionType(e.target.value as EventActionType)}
          style={{
            width: "100%",
            padding: "0.5rem",
            marginBottom: "1rem",
            border: `1px solid ${colors.borderStrong}`,
            borderRadius: "0.25rem",
          }}
        >
          {availableTypes.map((t) => (
            <option key={t} value={t}>
              {ACTION_META[t]?.label ?? t}
            </option>
          ))}
        </select>
        <div
          style={{
            display: "flex",
            flexDirection: isMobile ? "column" : "row",
            gap: "0.5rem",
            justifyContent: "flex-end",
          }}
        >
          <button
            onClick={onClose}
            disabled={submitting}
            style={{
              padding: "0.5rem 1rem",
              border: `1px solid ${colors.borderStrong}`,
              background: colors.background,
              borderRadius: "0.25rem",
              cursor: submitting ? "wait" : "pointer",
              width: isMobile ? "100%" : undefined,
            }}
          >
            キャンセル
          </button>
          <button
            onClick={handleAdd}
            disabled={submitting}
            style={{
              ...primaryBtnStyle,
              cursor: submitting ? "wait" : "pointer",
              width: isMobile ? "100%" : undefined,
            }}
          >
            {submitting ? "追加中..." : "追加"}
          </button>
        </div>
      </div>
    </div>
  );
}

const primaryBtnStyle: React.CSSProperties = {
  background: colors.primary,
  color: colors.textInverse,
  border: "none",
  padding: "0.5rem 1rem",
  borderRadius: "0.25rem",
  cursor: "pointer",
};
