import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { EventAction, EventActionType } from "../types";
import { api } from "../api";
import { ACTION_META } from "../lib/eventTabs";

// Sprint 13 PR1: アクション一覧 (カード形式)。
// クリックで /events/:eventId/actions/:actionType の専用ページへ遷移する。
// 追加導線は AddActionModal (旧 ActionsTab.tsx 由来) をそのまま流用。

const ALL_ACTION_TYPES: EventActionType[] = [
  "schedule_polling",
  "task_management",
  "member_welcome",
  "pr_review_list",
  "weekly_reminder",
];

type Props = {
  eventId: string;
  actions: EventAction[];
  onChange: () => void; // 追加後に親で再取得する
};

export function ActionsListView({ eventId, actions, onChange }: Props) {
  const navigate = useNavigate();
  const [showAdd, setShowAdd] = useState(false);

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
          アクション一覧 ({actions.length}件)
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

      {actions.length === 0 ? (
        <div
          style={{
            padding: "3rem 1rem",
            textAlign: "center",
            color: "#6b7280",
            border: "1px dashed #d1d5db",
            borderRadius: "0.5rem",
          }}
        >
          アクションが登録されていません。
          <br />
          「+ 新規追加」から追加してください。
        </div>
      ) : (
        <div style={{ display: "grid", gap: "0.75rem" }}>
          {actions.map((a) => {
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
                  border: "1px solid #e5e7eb",
                  borderRadius: "0.5rem",
                  cursor: "pointer",
                  background: "white",
                  opacity: a.enabled === 1 ? 1 : 0.6,
                  transition: "background 0.15s, border-color 0.15s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "#f9fafb";
                  e.currentTarget.style.borderColor = "#9ca3af";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "white";
                  e.currentTarget.style.borderColor = "#e5e7eb";
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
                        background: "#9ca3af",
                        color: "white",
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
                    color: "#6b7280",
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
      alert(e instanceof Error ? e.message : "追加に失敗しました");
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
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "white",
          padding: "1.5rem",
          borderRadius: "0.5rem",
          width: "min(400px, 90vw)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0 }}>アクション追加</h3>
        <label
          style={{
            display: "block",
            fontSize: "0.875rem",
            marginBottom: "0.25rem",
            color: "#374151",
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
            border: "1px solid #d1d5db",
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
            gap: "0.5rem",
            justifyContent: "flex-end",
          }}
        >
          <button
            onClick={onClose}
            disabled={submitting}
            style={{
              padding: "0.5rem 1rem",
              border: "1px solid #d1d5db",
              background: "#fff",
              borderRadius: "0.25rem",
              cursor: submitting ? "wait" : "pointer",
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
  background: "#2563eb",
  color: "white",
  border: "none",
  padding: "0.5rem 1rem",
  borderRadius: "0.25rem",
  cursor: "pointer",
};
