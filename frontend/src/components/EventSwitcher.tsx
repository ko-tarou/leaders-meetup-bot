import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useEvents } from "../contexts/EventContext";
import { api } from "../api";
import { colors } from "../styles/tokens";
import { useToast } from "./ui/Toast";
import { useIsMobile } from "../hooks/useIsMobile";

const CREATE_OPTION_VALUE = "__create__";

const labelStyle: React.CSSProperties = {
  color: colors.textMuted,
  fontSize: 13,
};

const selectStyle: React.CSSProperties = {
  padding: "6px 10px",
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: 4,
  background: colors.background,
  fontSize: 14,
  minWidth: 220,
  cursor: "pointer",
};

const createButtonStyle: React.CSSProperties = {
  padding: "6px 10px",
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: 4,
  background: colors.background,
  color: colors.text,
  fontSize: 13,
  cursor: "pointer",
};

function eventTypeLabel(type: string): string {
  if (type === "meetup") return "ミートアップ";
  if (type === "hackathon") return "ハッカソン";
  if (type === "project") return "プロジェクト";
  return type;
}

export function EventSwitcher() {
  const { events, currentEvent, setCurrentEventId, refreshEvents, loading } =
    useEvents();
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const isMobile = useIsMobile();

  if (loading) return <span style={labelStyle}>イベント読み込み中...</span>;

  // mobile はメニューシート内で縦並びになるため幅 100% にして tap し易くする。
  const select: React.CSSProperties = isMobile
    ? { ...selectStyle, width: "100%", minWidth: 0 }
    : selectStyle;
  const createBtn: React.CSSProperties = isMobile
    ? { ...createButtonStyle, width: "100%" }
    : createButtonStyle;

  return (
    <>
      {events.length === 0 ? (
        <button
          type="button"
          style={createBtn}
          onClick={() => setCreateOpen(true)}
        >
          ＋ 新規イベント作成
        </button>
      ) : (
        <select
          style={select}
          value={currentEvent?.id ?? ""}
          onChange={(e) => {
            const newId = e.target.value;
            if (newId === CREATE_OPTION_VALUE) {
              // 制御コンポーネントの value は currentEvent のまま維持し、
              // 選択状態は変えずにモーダルを開くだけにする。
              setCreateOpen(true);
              return;
            }
            setCurrentEventId(newId);
            // URL も同期: Sprint 13 PR1 でデフォルトタブを actions 固定に変更。
            const newEvent = events.find((ev) => ev.id === newId);
            if (newEvent) {
              navigate(`/events/${newId}/actions`);
            }
          }}
          aria-label="イベント切替"
        >
          {events.map((event) => (
            <option key={event.id} value={event.id}>
              {event.name}（{eventTypeLabel(event.type)}）
            </option>
          ))}
          <option value={CREATE_OPTION_VALUE}>＋ 新規イベント作成</option>
        </select>
      )}
      {createOpen && (
        <CreateEventModal
          onClose={() => setCreateOpen(false)}
          onCreated={async (newId) => {
            await refreshEvents();
            setCurrentEventId(newId);
            navigate(`/events/${newId}/actions`);
            setCreateOpen(false);
          }}
        />
      )}
    </>
  );
}

type EventType = "meetup" | "hackathon" | "project";

const EVENT_TYPES: { value: EventType; label: string }[] = [
  { value: "meetup", label: "ミートアップ" },
  { value: "hackathon", label: "ハッカソン" },
  { value: "project", label: "プロジェクト" },
];

function CreateEventModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (newId: string) => void | Promise<void>;
}) {
  const toast = useToast();
  const isMobile = useIsMobile();
  const [name, setName] = useState("");
  const [type, setType] = useState<EventType>("meetup");
  const [submitting, setSubmitting] = useState(false);

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("イベント名を入力してください");
      return;
    }
    setSubmitting(true);
    try {
      const created = await api.events.create({ type, name: trimmed });
      toast.success("イベントを作成しました");
      await onCreated(created.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "作成に失敗しました");
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
        <h3 style={{ marginTop: 0 }}>新規イベント作成</h3>
        <label
          style={{
            display: "block",
            fontSize: "0.875rem",
            marginBottom: "0.25rem",
            color: colors.text,
          }}
        >
          イベント名
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={submitting}
          style={{
            width: "100%",
            padding: "0.5rem",
            marginBottom: "1rem",
            border: `1px solid ${colors.borderStrong}`,
            borderRadius: "0.25rem",
            boxSizing: "border-box",
          }}
        />
        <label
          style={{
            display: "block",
            fontSize: "0.875rem",
            marginBottom: "0.25rem",
            color: colors.text,
          }}
        >
          種別
        </label>
        <select
          value={type}
          onChange={(e) => setType(e.target.value as EventType)}
          disabled={submitting}
          style={{
            width: "100%",
            padding: "0.5rem",
            marginBottom: "1rem",
            border: `1px solid ${colors.borderStrong}`,
            borderRadius: "0.25rem",
          }}
        >
          {EVENT_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
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
            type="button"
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
            type="button"
            onClick={handleCreate}
            disabled={submitting}
            style={{
              padding: "0.5rem 1rem",
              border: "none",
              background: colors.primary,
              color: "white",
              borderRadius: "0.25rem",
              cursor: submitting ? "wait" : "pointer",
              width: isMobile ? "100%" : undefined,
            }}
          >
            {submitting ? "作成中..." : "作成"}
          </button>
        </div>
      </div>
    </div>
  );
}
