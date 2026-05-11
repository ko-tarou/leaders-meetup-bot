import { useEffect, useState, type CSSProperties } from "react";
import { api } from "../api";
import type { Workspace } from "../types";
import { SingleChannelPicker } from "./ui/SingleChannelPicker";
import { Button } from "./ui/Button";
import { useToast } from "./ui/Toast";
import { colors, fontSize, radius, space } from "../styles/tokens";

// schedule_polling のメイン画面から呼び出されるミーティング作成フォーム。
// 既存はSlackの /meetup コマンド経由でしか作れなかったが、
// web UIから新規 event の日程調整を初回設定できるようにする。
//
// モーダルではなくページ内インライン form として描画する（呼び出し側で
// showCreate state で出し分け）。workspace は api.workspaces.list() から取得し、
// 1件のみなら自動選択。channel は SingleChannelPicker（検索 + ページング）で選ぶ。

type Props = {
  eventId: string;
  onCancel: () => void;
  onCreated: (meetingId: string) => void;
};

export function CreateMeetingForm({ eventId, onCancel, onCreated }: Props) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const [channelId, setChannelId] = useState("");
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.workspaces
      .list()
      .then((list) => {
        if (cancelled) return;
        const wsList = Array.isArray(list) ? list : [];
        setWorkspaces(wsList);
        if (wsList.length === 1) setWorkspaceId(wsList[0].id);
      })
      .catch(() => {
        if (!cancelled) setWorkspaces([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // workspace 切替時は channel 選択をリセット（WS 跨ぎで id が無効になるため）
  const handleWorkspaceChange = (id: string) => {
    setWorkspaceId(id);
    setChannelId("");
  };

  const handleSubmit = async () => {
    const trimmed = name.trim();
    if (!trimmed || !workspaceId || !channelId) {
      toast.error("ミーティング名、ワークスペース、チャンネルを入力してください");
      return;
    }
    setSubmitting(true);
    try {
      const meeting = await api.createMeeting({
        name: trimmed,
        channelId,
        eventId,
        workspaceId,
      });
      toast.success("ミーティングを作成しました");
      onCreated(meeting.id);
      // 成功時は親で unmount されるので setSubmitting(false) は不要
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "作成に失敗しました");
      setSubmitting(false);
    }
  };

  return (
    <div style={containerStyle}>
      <h3 style={{ margin: 0, fontSize: fontSize.lg }}>新規ミーティング作成</h3>

      <label style={fieldStyle}>
        <span style={labelStyle}>ミーティング名</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例: 週次定例"
          disabled={submitting}
          style={inputStyle}
        />
      </label>

      <label style={fieldStyle}>
        <span style={labelStyle}>ワークスペース</span>
        {workspaces === null ? (
          <span style={hintStyle}>読み込み中...</span>
        ) : workspaces.length === 0 ? (
          <span style={hintStyle}>ワークスペースが登録されていません</span>
        ) : (
          <select
            value={workspaceId}
            onChange={(e) => handleWorkspaceChange(e.target.value)}
            disabled={submitting}
            style={inputStyle}
          >
            <option value="">-- ワークスペースを選択 --</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        )}
      </label>

      <div style={fieldStyle}>
        <span style={labelStyle}>チャンネル</span>
        <SingleChannelPicker
          value={channelId}
          workspaceId={workspaceId}
          onChange={(id) => setChannelId(id)}
          disabled={submitting}
        />
      </div>

      <div style={{ display: "flex", gap: space.sm, marginTop: space.sm }}>
        <Button variant="primary" onClick={handleSubmit} isLoading={submitting}>
          作成
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={submitting}>
          キャンセル
        </Button>
      </div>
    </div>
  );
}

const containerStyle: CSSProperties = {
  border: `1px solid ${colors.border}`,
  borderRadius: radius.md,
  padding: space.lg,
  background: colors.background,
  display: "flex",
  flexDirection: "column",
  gap: space.md,
};

const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: space.xs,
};

const labelStyle: CSSProperties = {
  fontSize: fontSize.sm,
  color: colors.textSecondary,
  fontWeight: 500,
};

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: radius.sm,
  fontSize: fontSize.sm,
  fontFamily: "inherit",
  background: colors.background,
};

const hintStyle: CSSProperties = {
  color: colors.textMuted,
  fontSize: fontSize.sm,
};
