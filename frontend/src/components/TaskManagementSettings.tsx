import { useEffect, useState } from "react";
import type { Meeting, Workspace } from "../types";
import { api } from "../api";
import { ChannelSelector } from "./ChannelSelector";

// Sprint 13 PR2: タスク管理アクションの「設定」タブ。
// この event に紐づく meetings (= 影響するチャンネル) を一覧/追加/削除し、
// それぞれで sticky task board を ON/OFF できるようにする。

type Props = { eventId: string };

export function TaskManagementSettings({ eventId }: Props) {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [channelNames, setChannelNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showAdd, setShowAdd] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([api.getMeetings(eventId), api.workspaces.list()])
      .then(([ms, ws]) => {
        if (cancelled) return;
        setMeetings(Array.isArray(ms) ? ms : []);
        setWorkspaces(Array.isArray(ws) ? ws : []);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "読み込みに失敗しました");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, refreshKey]);

  // チャンネル名を非同期にキャッシュ（MeetingList の手法を踏襲）
  useEffect(() => {
    if (meetings.length === 0) return;
    meetings.forEach(async (m) => {
      if (channelNames[m.channelId] !== undefined) return;
      setChannelNames((prev) =>
        prev[m.channelId] !== undefined ? prev : { ...prev, [m.channelId]: "" },
      );
      try {
        const res = await api.getChannelName(m.channelId);
        setChannelNames((prev) => ({ ...prev, [m.channelId]: res.name }));
      } catch {
        // 取得失敗時は ID にフォールバック
      }
    });
  }, [meetings, channelNames]);

  const wsName = (id?: string | null) =>
    workspaces.find((w) => w.id === id)?.name ?? "不明な workspace";

  const handleToggleSticky = async (meeting: Meeting) => {
    setPendingId(meeting.id);
    try {
      const r = meeting.taskBoardTs
        ? await api.disableTaskBoard(meeting.id)
        : await api.enableTaskBoard(meeting.id);
      if (!r.ok) throw new Error(r.error ?? "切替に失敗しました");
      setRefreshKey((k) => k + 1);
    } catch (e) {
      alert(e instanceof Error ? e.message : "切替に失敗しました");
    } finally {
      setPendingId(null);
    }
  };

  const handleRemove = async (meeting: Meeting) => {
    if (
      !confirm(
        `「${meeting.name}」を影響チャンネルから外しますか？\n（sticky bot を有効化したまま削除すると Slack 上のメッセージは残ります）`,
      )
    )
      return;
    setPendingId(meeting.id);
    try {
      await api.deleteMeeting(meeting.id);
      setRefreshKey((k) => k + 1);
    } catch (e) {
      alert(e instanceof Error ? e.message : "削除に失敗しました");
    } finally {
      setPendingId(null);
    }
  };

  if (loading) return <div style={{ padding: "1rem" }}>読み込み中...</div>;
  if (error)
    return <div style={{ padding: "1rem", color: "#dc2626" }}>エラー: {error}</div>;

  return (
    <div>
      <div style={headerRowStyle}>
        <h3 style={{ margin: 0, fontSize: "1rem" }}>
          影響するチャンネル ({meetings.length})
        </h3>
        <button
          onClick={() => setShowAdd(true)}
          style={primaryBtnStyle}
          disabled={workspaces.length === 0}
        >
          + チャンネル追加
        </button>
      </div>

      <p style={descStyle}>
        ここに登録された各チャンネルでタスク管理機能（タスク作成・sticky bot）が動作します。
      </p>

      {meetings.length === 0 ? (
        <div style={emptyStyle}>
          まだチャンネルが登録されていません。
          <br />
          「+ チャンネル追加」から追加してください。
        </div>
      ) : (
        <div style={{ display: "grid", gap: "0.5rem" }}>
          {meetings.map((m) => {
            const isEnabled = !!m.taskBoardTs;
            const chName = channelNames[m.channelId];
            return (
              <div key={m.id} style={rowStyle}>
                <div style={rowInnerStyle}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <strong>{m.name}</strong>
                    <div style={metaStyle}>
                      {wsName(m.workspaceId)} / #{chName || m.channelId}
                    </div>
                  </div>
                  <label
                    style={{
                      ...toggleLabelStyle,
                      color: isEnabled ? "#16a34a" : "#6b7280",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={isEnabled}
                      onChange={() => handleToggleSticky(m)}
                      disabled={pendingId === m.id}
                    />
                    sticky bot {isEnabled ? "ON" : "OFF"}
                  </label>
                  <button
                    onClick={() => handleRemove(m)}
                    disabled={pendingId === m.id}
                    style={dangerBtnStyle}
                  >
                    削除
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showAdd && (
        <AddChannelModal
          eventId={eventId}
          workspaces={workspaces}
          onClose={() => setShowAdd(false)}
          onAdded={() => {
            setShowAdd(false);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}

function AddChannelModal({
  eventId,
  workspaces,
  onClose,
  onAdded,
}: {
  eventId: string;
  workspaces: Workspace[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const [workspaceId, setWorkspaceId] = useState<string>(workspaces[0]?.id ?? "");
  const [channelId, setChannelId] = useState<string>("");
  const [channelName, setChannelName] = useState<string>("");
  const [name, setName] = useState<string>("");
  const [enableSticky, setEnableSticky] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!workspaceId) return setError("ワークスペースを選択してください");
    if (!channelId.trim()) return setError("チャンネルを選択してください");
    setError(null);
    setSubmitting(true);
    try {
      const meetingName = name.trim() || channelName || `Channel ${channelId}`;
      const created = await api.createMeeting({
        name: meetingName,
        channelId: channelId.trim(),
        eventId,
        workspaceId,
      });
      if (enableSticky) {
        try {
          await api.enableTaskBoard(created.id);
        } catch (e) {
          console.warn("sticky bot 有効化に失敗しました:", e);
        }
      }
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : "追加に失敗しました");
      setSubmitting(false);
    }
  };

  return (
    <div style={modalBackdrop} onClick={onClose}>
      <div style={modalBody} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>チャンネル追加</h3>
        {error && <div style={errorStyle}>{error}</div>}

        <Field label="ワークスペース">
          <select
            value={workspaceId}
            onChange={(e) => {
              setWorkspaceId(e.target.value);
              setChannelId("");
              setChannelName("");
            }}
            style={fieldStyle}
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="チャンネル">
          <ChannelSelector
            value={channelId}
            onChange={(id, n) => {
              setChannelId(id);
              setChannelName(n);
            }}
            workspaceId={workspaceId || undefined}
          />
        </Field>

        <Field label="表示名（任意・空ならチャンネル名から自動）">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={channelName || "..."}
            style={fieldStyle}
          />
        </Field>

        <Field label="">
          <label style={{ fontSize: "0.875rem" }}>
            <input
              type="checkbox"
              checked={enableSticky}
              onChange={(e) => setEnableSticky(e.target.checked)}
            />{" "}
            追加と同時に sticky bot を有効化する
          </label>
        </Field>

        <div style={modalActionsStyle}>
          <button onClick={onClose} disabled={submitting} style={secondaryBtnStyle}>
            キャンセル
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || !channelId}
            style={primaryBtnStyle}
          >
            {submitting ? "追加中..." : "追加"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: "0.75rem" }}>
      {label && <label style={fieldLabelStyle}>{label}</label>}
      {children}
    </div>
  );
}

const headerRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  marginBottom: "0.5rem",
  gap: "0.5rem",
};
const descStyle: React.CSSProperties = {
  fontSize: "0.875rem",
  color: "#6b7280",
  margin: "0 0 1rem",
};
const rowStyle: React.CSSProperties = {
  padding: "0.75rem",
  border: "1px solid #e5e7eb",
  borderRadius: "0.375rem",
  background: "white",
};
const rowInnerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  flexWrap: "wrap",
};
const metaStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  color: "#6b7280",
  marginTop: "0.125rem",
};
const toggleLabelStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.25rem",
  fontSize: "0.875rem",
};
const emptyStyle: React.CSSProperties = {
  padding: "2rem",
  textAlign: "center",
  color: "#6b7280",
  border: "1px dashed #d1d5db",
  borderRadius: "0.5rem",
  fontSize: "0.875rem",
};
const errorStyle: React.CSSProperties = {
  color: "#dc2626",
  marginBottom: "0.5rem",
  fontSize: "0.875rem",
};
const fieldLabelStyle: React.CSSProperties = {
  display: "block",
  marginBottom: "0.25rem",
  fontSize: "0.875rem",
  color: "#374151",
};
const fieldStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.4rem 0.6rem",
  border: "1px solid #d1d5db",
  borderRadius: "0.25rem",
  fontSize: "0.875rem",
  boxSizing: "border-box",
};
const modalBackdrop: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};
const modalBody: React.CSSProperties = {
  background: "white",
  padding: "1.5rem",
  borderRadius: "0.5rem",
  width: "min(500px, 90vw)",
};
const modalActionsStyle: React.CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  justifyContent: "flex-end",
  marginTop: "1rem",
};
const primaryBtnStyle: React.CSSProperties = {
  marginLeft: "auto",
  background: "#2563eb",
  color: "white",
  border: "none",
  padding: "0.4rem 0.9rem",
  borderRadius: "0.25rem",
  cursor: "pointer",
  fontSize: "0.875rem",
};
const secondaryBtnStyle: React.CSSProperties = {
  padding: "0.4rem 0.9rem",
  border: "1px solid #d1d5db",
  background: "white",
  borderRadius: "0.25rem",
  cursor: "pointer",
  fontSize: "0.875rem",
};
const dangerBtnStyle: React.CSSProperties = {
  padding: "0.25rem 0.6rem",
  border: "1px solid #fecaca",
  background: "white",
  color: "#dc2626",
  borderRadius: "0.25rem",
  cursor: "pointer",
  fontSize: "0.8125rem",
};
