import { useEffect, useState, type CSSProperties } from "react";
import { api } from "../../api";
import type { MeetingDetail, Workspace } from "../../types";
import { SingleChannelPicker } from "../ui/SingleChannelPicker";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toast";
import { colors, fontSize, radius, space } from "../../styles/tokens";

// Sprint 005-tabs: schedule_polling の「チャンネル設定」サブタブ。
// schedule_polling は 1 meeting あたり 1 channel なので、ChannelManagementSection の
// ような複数登録 UI ではなく「現在の channel 表示 + 編集」のシンプルな form にする。
// channel 変更は api.updateMeeting({ channelId }) で永続化する。
//
// PR レビュー一覧 / task_management と同じ「workspace + 検索 + ページング」UI に
// 揃えるため、編集モードでは SingleChannelPicker (内部で ChannelPicker をラップ) を
// 使う。workspace dropdown は親側で表示し、SingleChannelPicker は単一 workspace 配下
// の channel 検索 + 選択に専念する。channel 選択時に自動的に updateMeeting が走る。

type Props = { meetingId: string; onChanged?: () => void };

export function ScheduleChannelTab({ meetingId, onChanged }: Props) {
  const toast = useToast();
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [channelName, setChannelName] = useState("");
  const [editing, setEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // 編集時の workspace 選択（親が SingleChannelPicker に workspaceId を渡す）
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getMeeting(meetingId), api.workspaces.list()])
      .then(([m, ws]) => {
        if (cancelled) return;
        setMeeting(m);
        setWorkspaces(Array.isArray(ws) ? ws : []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [meetingId]);

  // 現在の channel 名を表示用に取得
  useEffect(() => {
    if (!meeting?.channelId) {
      setChannelName("");
      return;
    }
    let cancelled = false;
    api
      .getChannelName(meeting.channelId)
      .then((res) => {
        if (!cancelled) setChannelName(res.name);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [meeting?.channelId]);

  // 編集モードに入るたびに workspace 選択を meeting に合わせて初期化
  useEffect(() => {
    if (!editing || !meeting) return;
    setSelectedWorkspaceId(meeting.workspaceId ?? workspaces[0]?.id ?? "");
  }, [editing, meeting, workspaces]);

  // 編集中、SingleChannelPicker に渡す「現在の選択 (除外したい channel)」。
  // workspace を別に切り替えた場合は元 channel ID は別 WS なので無効。
  const currentChannelForPicker =
    selectedWorkspaceId && meeting?.workspaceId === selectedWorkspaceId
      ? meeting.channelId
      : "";

  const handleChange = async (channelId: string, channelNameSel: string) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await api.updateMeeting(meetingId, { channelId });
      const updated = await api.getMeeting(meetingId);
      setMeeting(updated);
      toast.success(`チャンネルを #${channelNameSel} に変更しました`);
      setEditing(false);
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "更新に失敗しました");
    } finally {
      setSubmitting(false);
    }
  };

  if (!meeting) return <p style={{ color: colors.textSecondary }}>読み込み中...</p>;

  const wsName = (id?: string | null) =>
    workspaces.find((w) => w.id === id)?.name ?? "(workspace 未設定)";

  if (!editing) {
    return (
      <div style={cardStyle}>
        <h3 style={headingStyle}>チャンネル設定</h3>
        <p style={descStyle}>
          このミーティングの投票・リマインドが投稿される Slack チャンネルです。
        </p>
        <dl style={dlStyle}>
          <dt style={dtStyle}>ワークスペース</dt>
          <dd style={ddStyle}>{wsName(meeting.workspaceId)}</dd>
          <dt style={dtStyle}>チャンネル</dt>
          <dd style={ddStyle}>
            <code>#{channelName || meeting.channelId}</code>
          </dd>
        </dl>
        <div style={{ marginTop: space.md }}>
          <Button variant="primary" onClick={() => setEditing(true)}>
            チャンネルを変更
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div style={cardStyle}>
      <h3 style={headingStyle}>チャンネルを変更</h3>
      <p style={descStyle}>
        新しいチャンネルを選択すると、自動的に保存されます。
        現在のチャンネル: <code>#{channelName || meeting.channelId}</code>
      </p>

      {workspaces.length > 0 && (
        <div style={{ marginBottom: space.sm }}>
          <label
            style={{
              display: "block",
              fontSize: fontSize.sm,
              color: colors.textSecondary,
              marginBottom: space.xs,
            }}
          >
            ワークスペース
          </label>
          <select
            value={selectedWorkspaceId}
            onChange={(e) => setSelectedWorkspaceId(e.target.value)}
            disabled={submitting}
            style={{
              padding: "0.4rem 0.6rem",
              border: `1px solid ${colors.borderStrong}`,
              borderRadius: radius.sm,
              fontSize: fontSize.sm,
              minWidth: "200px",
            }}
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <SingleChannelPicker
        value={currentChannelForPicker}
        channelName={
          currentChannelForPicker ? channelName || currentChannelForPicker : ""
        }
        workspaceId={selectedWorkspaceId}
        onChange={handleChange}
        disabled={submitting}
      />

      <div style={{ display: "flex", gap: space.sm, marginTop: space.md }}>
        <Button
          variant="secondary"
          onClick={() => setEditing(false)}
          disabled={submitting}
        >
          キャンセル
        </Button>
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  background: colors.surface,
  border: `1px solid ${colors.border}`,
  borderRadius: radius.md,
  padding: space.lg,
};

const headingStyle: CSSProperties = {
  margin: `0 0 ${space.xs} 0`,
  fontSize: fontSize.lg,
};

const descStyle: CSSProperties = {
  margin: `0 0 ${space.md} 0`,
  color: colors.textSecondary,
  fontSize: fontSize.sm,
};

const dlStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto 1fr",
  gap: `${space.xs} ${space.md}`,
  margin: 0,
};

const dtStyle: CSSProperties = {
  color: colors.textSecondary,
  fontSize: fontSize.sm,
};

const ddStyle: CSSProperties = {
  margin: 0,
  fontSize: fontSize.sm,
};
