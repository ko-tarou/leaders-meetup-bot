import { useEffect, useState } from "react";
import { api } from "../api";

type Props = {
  value: string;
  onChange: (channelId: string, channelName: string) => void;
};

export function ChannelSelector({ value, onChange }: Props) {
  const [channels, setChannels] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .getSlackChannels()
      .then((list) => {
        if (Array.isArray(list)) setChannels(list);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <span style={{ color: "#999" }}>チャンネル取得中...</span>;
  }

  if (channels.length === 0) {
    return (
      <div
        style={{
          padding: 8,
          background: "#FFF3CD",
          border: "1px solid #FFE69C",
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
        border: "1px solid #ddd",
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
