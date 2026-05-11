import { useCallback, type CSSProperties } from "react";
import { api } from "../../api";
import {
  ChannelPicker,
  type SlackChannelLike,
  type WorkspaceLike,
} from "./ChannelPicker";
import { colors, fontSize } from "../../styles/tokens";

// 単一チャンネル選択用の共通テンプレート。
//
// 既存 `ChannelPicker` (複数登録 UI) をラップし、単一チャンネル選択でも
// 「検索 + ページング + クリック選択」の UX を共通化する。
// workspace は親が選択して渡す前提で、workspace dropdown は内部で非表示にする。
// 現在の選択は registeredChannelIds に渡して候補から除外する。

export type SingleChannelPickerProps = {
  /** 選択中のチャンネル ID（未選択時は空文字） */
  value: string;
  /** 表示用の現在チャンネル名（任意） */
  channelName?: string;
  /** チャンネル選択時のコールバック */
  onChange: (channelId: string, channelName: string) => void;
  /** workspace ID（必須）— 親で選択した workspace を渡す */
  workspaceId: string;
  /** disable フラグ */
  disabled?: boolean;
};

export function SingleChannelPicker({
  value,
  channelName,
  onChange,
  workspaceId,
  disabled,
}: SingleChannelPickerProps) {
  // ChannelPicker は workspaces 配列を要求するため、単一要素のダミーを渡しつつ
  // hideWorkspaceSelector で dropdown を非表示にする。
  const workspaces: WorkspaceLike[] = workspaceId
    ? [{ id: workspaceId, name: workspaceId }]
    : [];

  const fetchChannels = useCallback(
    (wsId: string) =>
      api.getSlackChannels(wsId).then((list) =>
        Array.isArray(list) ? list : [],
      ),
    [],
  );

  const handleAdd = useCallback(
    (channel: SlackChannelLike) => {
      onChange(channel.id, channel.name);
    },
    [onChange],
  );

  if (!workspaceId) {
    return (
      <div style={hintStyle}>ワークスペースを先に選択してください。</div>
    );
  }

  return (
    <div>
      {value && (
        <div style={currentRowStyle}>
          選択中: <code>#{channelName || value}</code>
        </div>
      )}
      <ChannelPicker
        workspaces={workspaces}
        selectedWorkspaceId={workspaceId}
        onWorkspaceChange={() => {
          /* 親が workspace を制御するので no-op */
        }}
        fetchChannels={fetchChannels}
        registeredChannelIds={new Set(value ? [value] : [])}
        onAdd={handleAdd}
        disabled={disabled}
        hideWorkspaceSelector
      />
    </div>
  );
}

const currentRowStyle: CSSProperties = {
  marginBottom: "0.5rem",
  fontSize: fontSize.sm,
  color: colors.textSecondary,
};

const hintStyle: CSSProperties = {
  padding: "0.75rem",
  color: colors.textMuted,
  fontSize: fontSize.sm,
  border: `1px dashed ${colors.border}`,
  borderRadius: 4,
};
