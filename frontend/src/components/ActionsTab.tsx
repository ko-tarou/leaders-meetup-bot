import { useState } from "react";
import type { EventAction, EventActionType } from "../types";
import { api } from "../api";
import { ACTION_TAB_INFO } from "../lib/eventTabs";
import { ActionConfigModal } from "./ActionConfigModal";

// ADR-0008 / Sprint 10 PR4: アクション管理UI。
// 一覧 / 追加 / 有効化トグル / 削除 を提供する。

const ALL_ACTION_TYPES: EventActionType[] = [
  "schedule_polling",
  "task_management",
  "member_welcome",
  "pr_review_list",
];

type Props = {
  eventId: string;
  actions: EventAction[];
  onChange: () => void; // mutation 後に親で再取得する
};

export function ActionsTab({ eventId, actions, onChange }: Props) {
  const [showAdd, setShowAdd] = useState(false);
  // mutation 中の action id (二重押下防止)
  const [pending, setPending] = useState<string | null>(null);
  // 設定モーダルを開いている action（null = 非表示）
  const [editingConfig, setEditingConfig] = useState<EventAction | null>(null);

  const usedTypes = new Set(actions.map((a) => a.actionType));
  const availableTypes = ALL_ACTION_TYPES.filter((t) => !usedTypes.has(t));

  const handleToggle = async (action: EventAction) => {
    setPending(action.id);
    try {
      await api.events.actions.update(eventId, action.id, {
        enabled: action.enabled === 1 ? 0 : 1,
      });
      onChange();
    } catch (e) {
      alert(e instanceof Error ? e.message : "更新に失敗しました");
    } finally {
      setPending(null);
    }
  };

  const handleDelete = async (action: EventAction) => {
    const label = ACTION_TAB_INFO[action.actionType]?.label ?? action.actionType;
    if (!confirm(`アクション「${label}」を削除しますか？`)) return;
    setPending(action.id);
    try {
      await api.events.actions.delete(eventId, action.id);
      onChange();
    } catch (e) {
      alert(e instanceof Error ? e.message : "削除に失敗しました");
    } finally {
      setPending(null);
    }
  };

  return (
    <div style={{ padding: "1rem" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          marginBottom: "1rem",
        }}
      >
        <h2 style={{ margin: 0, fontSize: "1.1rem" }}>
          アクション設定 ({actions.length}件)
        </h2>
        {availableTypes.length > 0 && (
          <button
            onClick={() => setShowAdd(true)}
            style={{
              marginLeft: "auto",
              background: "#2563eb",
              color: "white",
              border: "none",
              padding: "0.5rem 1rem",
              borderRadius: "0.25rem",
              cursor: "pointer",
            }}
          >
            + 新規追加
          </button>
        )}
      </div>

      {actions.length === 0 && (
        <div style={{ color: "#6b7280", padding: "1rem" }}>
          登録されているアクションはありません。「+ 新規追加」から追加してください。
        </div>
      )}

      {actions.map((a) => {
        const info = ACTION_TAB_INFO[a.actionType];
        const isPending = pending === a.id;
        return (
          <div
            key={a.id}
            style={{
              border: "1px solid #e5e7eb",
              borderRadius: "0.375rem",
              padding: "0.75rem",
              marginBottom: "0.5rem",
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              background: a.enabled === 1 ? "#fff" : "#f9fafb",
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <strong>{info?.label ?? a.actionType}</strong>
              <div style={{ fontSize: "0.75rem", color: "#6b7280" }}>
                type: {a.actionType} / 状態:{" "}
                {a.enabled === 1 ? "有効" : "無効"}
              </div>
            </div>
            <button
              onClick={() => setEditingConfig(a)}
              disabled={isPending}
              style={{
                padding: "0.25rem 0.75rem",
                border: "1px solid #d1d5db",
                borderRadius: "0.25rem",
                background: "#fff",
                cursor: isPending ? "wait" : "pointer",
              }}
            >
              設定
            </button>
            <button
              onClick={() => handleToggle(a)}
              disabled={isPending}
              style={{
                padding: "0.25rem 0.75rem",
                border: "1px solid #d1d5db",
                borderRadius: "0.25rem",
                background: "#fff",
                cursor: isPending ? "wait" : "pointer",
              }}
            >
              {a.enabled === 1 ? "無効化" : "有効化"}
            </button>
            <button
              onClick={() => handleDelete(a)}
              disabled={isPending}
              style={{
                background: "#dc2626",
                color: "white",
                border: "none",
                padding: "0.25rem 0.75rem",
                borderRadius: "0.25rem",
                cursor: isPending ? "wait" : "pointer",
              }}
            >
              削除
            </button>
          </div>
        );
      })}

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

      {editingConfig && (
        <ActionConfigModal
          eventId={eventId}
          action={editingConfig}
          onClose={() => setEditingConfig(null)}
          onSaved={() => {
            setEditingConfig(null);
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
              {ACTION_TAB_INFO[t]?.label ?? t}
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
              background: "#2563eb",
              color: "white",
              border: "none",
              padding: "0.5rem 1rem",
              borderRadius: "0.25rem",
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
