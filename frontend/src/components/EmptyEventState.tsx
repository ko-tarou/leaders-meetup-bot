import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useEvents } from "../contexts/EventContext";
import { api } from "../api";
import { type EventType } from "../lib/eventTabs";
import { colors } from "../styles/tokens";
import { EmptyState } from "./EmptyState";
import { useToast } from "./ui/Toast";

// events 0件時に表示する空状態UI。
// 「イベントを作成」CTA → 簡易フォームで作成 → 作成後その event の既定タブへ。
//
// UX 改善 Phase 1 - PR2 (J): 共通 <EmptyState /> を採用して見た目を統一。
// フォーム展開後は EmptyState の extra スロットに inline form を描画する。
export function EmptyEventState() {
  const toast = useToast();
  const { refreshEvents, setCurrentEventId } = useEvents();
  const navigate = useNavigate();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<EventType>("meetup");
  const [submitting, setSubmitting] = useState(false);

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      const created = await api.events.create({ type, name: trimmed });
      await refreshEvents();
      setCurrentEventId(created.id);
      navigate(`/events/${created.id}/actions`, { replace: true });
    } catch (e) {
      console.error("event creation failed", e);
      toast.error("イベント作成に失敗しました");
      setSubmitting(false);
    }
  };

  return (
    <div style={{ padding: "3rem 0" }}>
      <EmptyState
        icon="📅"
        title="イベントがありません"
        description="最初のイベントを作成して始めましょう。後からアクションを追加できます。"
        primaryAction={
          !showForm
            ? {
                label: "＋ イベントを作成",
                onClick: () => setShowForm(true),
              }
            : undefined
        }
        extra={
          showForm ? (
            <div
              style={{
                display: "inline-flex",
                flexDirection: "column",
                gap: 8,
                minWidth: 260,
                width: "100%",
                maxWidth: 320,
                margin: "0 auto",
              }}
            >
              <input
                placeholder="イベント名 (例: HackIt 2026)"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={submitting}
                style={inputStyle}
                autoFocus
              />
              <select
                value={type}
                onChange={(e) => setType(e.target.value as EventType)}
                disabled={submitting}
                style={inputStyle}
              >
                <option value="meetup">ミートアップ</option>
                <option value="hackathon">ハッカソン</option>
              </select>
              <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
                <button
                  onClick={() => {
                    setShowForm(false);
                    setName("");
                  }}
                  disabled={submitting}
                  style={cancelBtnStyle}
                >
                  キャンセル
                </button>
                <button
                  onClick={handleCreate}
                  disabled={submitting || !name.trim()}
                  style={primaryBtnStyle}
                >
                  {submitting ? "作成中..." : "作成"}
                </button>
              </div>
            </div>
          ) : undefined
        }
      />
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "8px 12px",
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: 4,
  fontSize: 14,
};

const baseBtnStyle: React.CSSProperties = {
  padding: "10px 20px",
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 14,
  minHeight: 40,
};

const primaryBtnStyle: React.CSSProperties = {
  ...baseBtnStyle,
  background: colors.primary,
  color: colors.textInverse,
};

const cancelBtnStyle: React.CSSProperties = {
  ...baseBtnStyle,
  background: colors.surface,
  color: colors.text,
  border: `1px solid ${colors.borderStrong}`,
};
