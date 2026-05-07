import { useEffect, useState } from "react";
import { api } from "../api";
import { colors } from "../styles/tokens";

type Props = {
  value: string;
  onChange: (channelId: string, channelName: string) => void;
  // ADR-0006: 任意 workspace の channel を取得する。未指定時は default WS（後方互換）
  workspaceId?: string;
};

export function ChannelSelector({ value, onChange, workspaceId }: Props) {
  const [channels, setChannels] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api
      .getSlackChannels(workspaceId)
      .then((list) => {
        if (Array.isArray(list)) setChannels(list);
        else setChannels([]);
      })
      .catch(() => setChannels([]))
      .finally(() => setLoading(false));
  }, [workspaceId]);

  if (loading) {
    return <span style={{ color: colors.textMuted }}>チャンネル取得中...</span>;
  }

  if (channels.length === 0) {
    return (
      <div
        style={{
          padding: 8,
          background: colors.warningSubtle,
          border: `1px solid ${colors.warning}`,
          borderRadius: 4,
          fontSize: 13,
        }}
      >
        Botが参加中のチャンネルがありません。Slackで{" "}
        <code>/invite @Leaders Meetup Bot</code> を実行してください。
      </div>
    );
  }

  return (
    <select
      value={value}
      onChange={(e) => {
        const ch = channels.find((c) => c.id === e.target.value);
        if (ch) onChange(ch.id, ch.name);
        else onChange("", "");
      }}
      style={{
        padding: "8px 12px",
        border: `1px solid ${colors.borderStrong}`,
        borderRadius: 4,
        minWidth: 200,
      }}
    >
      <option value="">-- チャンネルを選択 --</option>
      {channels.map((ch) => (
        <option key={ch.id} value={ch.id}>
          #{ch.name}
        </option>
      ))}
    </select>
  );
}
