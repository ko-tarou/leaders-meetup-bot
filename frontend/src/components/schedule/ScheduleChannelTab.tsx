import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { api } from "../../api";
import type { MeetingDetail, Workspace } from "../../types";
import {
  ChannelPicker,
  type SlackChannelLike,
} from "../ui/ChannelPicker";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toast";
import { colors, fontSize, radius, space } from "../../styles/tokens";

// Sprint 005-tabs: schedule_polling の「チャンネル設定」サブタブ。
// schedule_polling は 1 meeting あたり 1 channel なので、ChannelManagementSection の
// ような複数登録 UI ではなく「現在の channel 表示 + 編集」のシンプルな form にする。
// channel 変更は api.updateMeeting({ channelId }) で永続化する。
//
// PR レビュー一覧 / task_management と同じ「workspace + 検索 + ページング」UI に
// 揃えるため、編集モードでは ChannelPicker を再利用する。単一 channel しか持たない
// ので、現在の channel ID を registeredChannelIds に渡して候補から除外し、
// 別の channel を 1 つ選ぶと自動で updateMeeting が走る フローにしている。

type Props = { meetingId: string; onChanged?: () => void };

export function ScheduleChannelTab({ meetingId, onChanged }: Props) {
  const toast = useToast();
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [channelName, setChannelName] = useState("");
  const [editing, setEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // ChannelPicker 用の workspace 選択
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

  // 現在 channel を候補から除外するため Set として渡す。
  // workspace を切り替えた場合は除外不要なので空 Set にする。
  const registeredIdSet = useMemo(() => {
    if (!meeting) return new Set<string>();
    if (selectedWorkspaceId && meeting.workspaceId && selectedWorkspaceId !== meeting.workspaceId) {
      return new Set<string>();
    }
    return new Set<string>([meeting.channelId]);
  }, [meeting, selectedWorkspaceId]);

  const fetchChannelsForPicker = (workspaceId: string) =>
    api.getSlackChannels(workspaceId).then((list) =>
      Array.isArray(list) ? list : [],
    );

  const handleAdd = async (channel: SlackChannelLike) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await api.updateMeeting(meetingId, { channelId: channel.id });
      const updated = await api.getMeeting(meetingId);
      setMeeting(updated);
      toast.success(`チャンネルを #${channel.name} に変更しました`);
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

      <ChannelPicker
        workspaces={workspaces}
        selectedWorkspaceId={selectedWorkspaceId}
        onWorkspaceChange={setSelectedWorkspaceId}
        fetchChannels={fetchChannelsForPicker}
        registeredChannelIds={registeredIdSet}
        onAdd={handleAdd}
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
