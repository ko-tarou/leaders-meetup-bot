import { useEffect, useState } from "react";
import { api } from "../api";
import type { Workspace } from "../types";
import { ChannelSelector } from "./ChannelSelector";
import { Button } from "./ui/Button";
import { useToast } from "./ui/Toast";
import { colors, fontSize, radius, space } from "../styles/tokens";

// schedule_polling のメイン画面から呼び出されるミーティング作成フォーム。
// 既存はSlackの /meetup コマンド経由でしか作れなかったが、
// web UIから新規 event の日程調整を初回設定できるようにするためのフォーム。
//
// 実装方針:
// - モーダルではなくページ内インライン form として描画する（呼び出し側で
//   showCreate state を持って出し分ける）。SchedulePollingMain の他状態と
//   同じレイアウトサーフェスに乗るので導線が単純。
// - workspace は api.workspaces.list() から取得。1件しかない場合は自動選択。
// - channel は既存の ChannelSelector を再利用（workspaceId 連動）。

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
        // 1件しかない場合は自動選択（後方互換: default WS のみのケース）
        if (wsList.length === 1) setWorkspaceId(wsList[0].id);
      })
      .catch(() => {
        if (cancelled) return;
        setWorkspaces([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // workspace を切り替えたら channel 選択をリセット
  // （workspace ごとに channel id が異なるため）
  const handleWorkspaceChange = (id: string) => {
    setWorkspaceId(id);
    setChannelId("");
  };

  const handleSubmit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("ミーティング名を入力してください");
      return;
    }
    if (!workspaceId) {
      toast.error("ワークスペースを選択してください");
      return;
    }
    if (!channelId) {
      toast.error("チャンネルを選択してください");
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
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "作成に失敗しました");
      setSubmitting(false);
    }
    // 成功時は onCreated → 親で unmount されるので setSubmitting(false) は不要
  };

  return (
    <div
      style={{
        border: `1px solid ${colors.border}`,
        borderRadius: radius.md,
        padding: space.lg,
        background: colors.background,
        display: "flex",
        flexDirection: "column",
        gap: space.md,
      }}
    >
      <h3 style={{ margin: 0, fontSize: fontSize.lg }}>新規ミーティング作成</h3>

      <label style={labelStyle}>
        <span style={labelTextStyle}>ミーティング名</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例: 週次定例"
          disabled={submitting}
          style={inputStyle}
        />
      </label>

      <label style={labelStyle}>
        <span style={labelTextStyle}>ワークスペース</span>
        {workspaces === null ? (
          <span style={{ color: colors.textMuted, fontSize: fontSize.sm }}>
            読み込み中...
          </span>
        ) : workspaces.length === 0 ? (
          <span style={{ color: colors.textMuted, fontSize: fontSize.sm }}>
            ワークスペースが登録されていません
          </span>
        ) : (
          <select
            value={workspaceId}
            onChange={(e) => handleWorkspaceChange(e.target.value)}
            disabled={submitting}
            style={selectStyle}
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

      <label style={labelStyle}>
        <span style={labelTextStyle}>チャンネル</span>
        <ChannelSelector
          value={channelId}
          workspaceId={workspaceId || undefined}
          onChange={(id) => setChannelId(id)}
        />
      </label>

      <div style={{ display: "flex", gap: space.sm, marginTop: space.sm }}>
        <Button
          variant="primary"
          onClick={handleSubmit}
          isLoading={submitting}
          disabled={submitting}
        >
          作成
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={submitting}>
          キャンセル
        </Button>
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: space.xs,
};

const labelTextStyle: React.CSSProperties = {
  fontSize: fontSize.sm,
  color: colors.textSecondary,
  fontWeight: 500,
};

const inputStyle: React.CSSProperties = {
  padding: "8px 12px",
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: radius.sm,
  fontSize: fontSize.sm,
  fontFamily: "inherit",
};

const selectStyle: React.CSSProperties = {
  padding: "8px 12px",
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: radius.sm,
  fontSize: fontSize.sm,
  fontFamily: "inherit",
  background: colors.background,
};
