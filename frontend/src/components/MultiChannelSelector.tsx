import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { api } from "../api";
import { colors } from "../styles/tokens";

// Sprint 23 PR4: 複数チャンネル選択用 dropdown + chip コンポーネント。
// ChannelSelector (単一) を拡張し、values: string[] を扱う。
// 既知 channelId は `#name` 表示、未知 ID は ID をそのまま chip に出してフォールバックする。

type Props = {
  values: string[];
  onChange: (next: string[]) => void;
  // ADR-0006: 任意 workspace の channel を取得する。未指定時は default WS（後方互換）
  workspaceId?: string;
  ariaLabel?: string;
};

export function MultiChannelSelector({
  values,
  onChange,
  workspaceId,
  ariaLabel,
}: Props) {
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

  // 既知 ID → name の lookup
  const idToName = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of channels) m.set(c.id, c.name);
    return m;
  }, [channels]);

  // dropdown に出す候補 = bot 参加チャンネル ∖ すでに選択済
  const remaining = useMemo(
    () => channels.filter((c) => !values.includes(c.id)),
    [channels, values],
  );

  const remove = (id: string) => onChange(values.filter((v) => v !== id));
  const add = (id: string) => {
    if (!id) return;
    if (values.includes(id)) return;
    onChange([...values, id]);
  };

  if (loading) {
    return <span style={{ color: colors.textMuted }}>チャンネル取得中...</span>;
  }

  // bot 参加チャンネルが 0 件の場合は ChannelSelector と同じ警告を出す。
  // ただし既に登録された ID (values) があれば chip として表示は維持する。
  if (channels.length === 0 && values.length === 0) {
    return (
      <div style={s.warn}>
        Botが参加中のチャンネルがありません。Slackで{" "}
        <code>/invite @Leaders Meetup Bot</code> を実行してください。
      </div>
    );
  }

  return (
    <div>
      {values.length > 0 && (
        <div style={s.row}>
          {values.map((id) => {
            const name = idToName.get(id);
            return (
              <span key={id} style={s.chip}>
                {name ? `#${name}` : id}
                <button
                  type="button"
                  onClick={() => remove(id)}
                  style={s.x}
                  aria-label={`チャンネル ${name ? `#${name}` : id} を削除`}
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}
      {channels.length === 0 ? (
        <div style={s.warn}>
          Botが参加中のチャンネルがありません。Slackで{" "}
          <code>/invite @Leaders Meetup Bot</code> を実行してください。
        </div>
      ) : (
        <select
          value=""
          onChange={(e) => {
            add(e.target.value);
            // セレクトをプレースホルダに戻す
            e.currentTarget.value = "";
          }}
          aria-label={ariaLabel ?? "チャンネルを追加"}
          disabled={remaining.length === 0}
          style={s.select}
        >
          <option value="">
            {remaining.length === 0
              ? "-- すべて追加済み --"
              : "-- チャンネルを追加 --"}
          </option>
          {remaining.map((c) => (
            <option key={c.id} value={c.id}>
              #{c.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  row: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.25rem",
    marginBottom: "0.5rem",
  },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.25rem",
    background: colors.border,
    color: colors.text,
    fontSize: "0.75rem",
    padding: "0.125rem 0.5rem",
    borderRadius: "9999px",
  },
  x: {
    background: "transparent",
    border: "none",
    cursor: "pointer",
    color: colors.textSecondary,
    padding: 0,
    fontSize: "0.875rem",
    lineHeight: 1,
  },
  select: {
    padding: "8px 12px",
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: 4,
    minWidth: 200,
  },
  warn: {
    padding: 8,
    background: colors.warningSubtle,
    border: `1px solid ${colors.warning}`,
    borderRadius: 4,
    fontSize: 13,
  },
};
