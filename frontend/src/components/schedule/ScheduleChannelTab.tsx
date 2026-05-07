import { useEffect, useState, type CSSProperties } from "react";
import { api } from "../../api";
import type { MeetingDetail, Workspace } from "../../types";
import { ChannelSelector } from "../ChannelSelector";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toast";
import { colors, fontSize, radius, space } from "../../styles/tokens";

// Sprint 005-tabs: schedule_polling の「チャンネル設定」サブタブ。
// schedule_polling は 1 meeting あたり 1 channel なので、ChannelManagementSection の
// ような複数登録 UI ではなく「現在の channel 表示 + 編集」のシンプルな form にする。
// channel 変更は api.updateMeeting({ channelId }) で永続化する。

type Props = { meetingId: string; onChanged?: () => void };

export function ScheduleChannelTab({ meetingId, onChanged }: Props) {
  const toast = useToast();
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [channelName, setChannelName] = useState("");
  const [editing, setEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // 編集中の選択値
  const [draftWorkspaceId, setDraftWorkspaceId] = useState("");
  const [draftChannelId, setDraftChannelId] = useState("");

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

  const startEdit = () => {
    if (!meeting) return;
    setDraftWorkspaceId(meeting.workspaceId ?? workspaces[0]?.id ?? "");
    setDraftChannelId(meeting.channelId);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraftChannelId("");
    setDraftWorkspaceId("");
  };

  const handleSave = async () => {
    if (!draftChannelId) {
      toast.error("チャンネルを選択してください");
      return;
    }
    setSubmitting(true);
    try {
      await api.updateMeeting(meetingId, { channelId: draftChannelId });
      toast.success("チャンネルを更新しました");
      // 最新を取り直す
      const updated = await api.getMeeting(meetingId);
      setMeeting(updated);
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
          <Button variant="primary" onClick={startEdit}>
            チャンネルを変更
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div style={cardStyle}>
      <h3 style={headingStyle}>チャンネルを変更</h3>

      <label style={fieldStyle}>
        <span style={labelStyle}>ワークスペース</span>
        {workspaces.length === 0 ? (
          <span style={{ color: colors.textMuted, fontSize: fontSize.sm }}>
            ワークスペースが登録されていません
          </span>
        ) : (
          <select
            value={draftWorkspaceId}
            onChange={(e) => {
              setDraftWorkspaceId(e.target.value);
              // workspace 切替時は channel 選択をクリア
              setDraftChannelId("");
            }}
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

      <label style={fieldStyle}>
        <span style={labelStyle}>チャンネル</span>
        <ChannelSelector
          value={draftChannelId}
          workspaceId={draftWorkspaceId || undefined}
          onChange={(id) => setDraftChannelId(id)}
        />
      </label>

      <div style={{ display: "flex", gap: space.sm, marginTop: space.sm }}>
        <Button variant="primary" onClick={handleSave} isLoading={submitting}>
          保存
        </Button>
        <Button variant="secondary" onClick={cancelEdit} disabled={submitting}>
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

const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: space.xs,
  marginTop: space.md,
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
