import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { api } from "../api";
import type { Workspace } from "../types";
import type { ReminderDraft } from "./ReminderCard";
import { ChannelPicker, type SlackChannelLike } from "./ui/ChannelPicker";
import { useToast } from "./ui/Toast";

// Sprint 23 PR-B/C: weekly_reminder 詳細画面の「チャンネル管理」タブ。
// task_management の ChannelManagementSection と同等の UX:
// workspace selector + 検索 + ページネーション付きで bot 参加中チャンネルを
// 一覧表示し、+ 追加 / × 削除 を即時保存する。
//
// データモデルの違い:
// - task_management: meetings テーブルの行を作る/削除する
// - weekly_reminder: 1 reminder の channelIds 配列を更新する
//
// Sprint 005-11: 追加 UI 部分は ui/ChannelPicker.tsx に共通化済み。
// 本コンポーネントは「登録済みチャンネル一覧 (× 削除)」+ reminder 状態管理
// に責務を絞る。channelIds の name 解決のため、選択中 workspace の
// チャンネル一覧を ChannelPicker と並行して取得する。

type Props = {
  reminder: ReminderDraft;
  disabled?: boolean;
  // 即時保存。channelIds の追加/削除のたびに呼ばれる。
  onSave: (next: ReminderDraft) => Promise<void> | void;
};

// channelIds に含まれる ID を、選択中 workspace のチャンネル一覧で name 解決して
// 表示するための行データ。未知 ID は ID のままフォールバック表示する。
type RegisteredRow = {
  id: string;
  name: string | null;
};

export function ReminderChannelTab({ reminder, disabled, onSave }: Props) {
  const toast = useToast();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [wsLoading, setWsLoading] = useState(true);
  const [wsError, setWsError] = useState<string | null>(null);

  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>("");

  // 登録済みチャンネルの name 解決用に、選択中 workspace の channels を保持する。
  // ChannelPicker も内部で同じデータを fetch するが、登録済みリストの表示にも
  // 必要なため呼び出し側でも保持する。
  // ChannelPicker に渡す fetchChannels は、API 呼び出しの結果をここにも反映する
  // ラッパーにする（重複 fetch を避ける）。
  const [workspaceChannels, setWorkspaceChannels] = useState<SlackChannelLike[]>(
    [],
  );
  const [pendingChannelId, setPendingChannelId] = useState<string | null>(null);

  // workspaces 初期 fetch
  useEffect(() => {
    let cancelled = false;
    setWsLoading(true);
    api.workspaces
      .list()
      .then((ws) => {
        if (cancelled) return;
        const list = Array.isArray(ws) ? ws : [];
        setWorkspaces(list);
        setSelectedWorkspaceId((cur) => cur || list[0]?.id || "");
        setWsLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setWsError(e instanceof Error ? e.message : "読み込みに失敗しました");
        setWsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ChannelPicker から渡された fetchChannels の結果を、登録済み行の name 解決
  // 用にも保持する。重複 fetch を避けるためのラッパー関数。
  const fetchChannelsForPicker = useMemo(
    () => (workspaceId: string) =>
      api.getSlackChannels(workspaceId).then((list) => {
        const arr = Array.isArray(list) ? list : [];
        setWorkspaceChannels(arr);
        return arr;
      }),
    [],
  );

  const channelById = useMemo(() => {
    const m = new Map<string, SlackChannelLike>();
    for (const c of workspaceChannels) m.set(c.id, c);
    return m;
  }, [workspaceChannels]);

  // 既登録一覧 (= reminder.channelIds)。選択中 workspace のチャンネルとして
  // name 解決し、見つからない場合は ID のままフォールバック表示する。
  const registeredRows: RegisteredRow[] = useMemo(
    () =>
      reminder.channelIds.map((id) => ({
        id,
        name: channelById.get(id)?.name ?? null,
      })),
    [reminder.channelIds, channelById],
  );

  const registeredIdSet = useMemo(
    () => new Set(reminder.channelIds),
    [reminder.channelIds],
  );

  const handleAdd = async (channel: SlackChannelLike) => {
    setPendingChannelId(channel.id);
    try {
      const next: ReminderDraft = {
        ...reminder,
        channelIds: [...reminder.channelIds, channel.id],
      };
      await onSave(next);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "追加に失敗しました");
    } finally {
      setPendingChannelId(null);
    }
  };

  const handleRemove = async (id: string) => {
    setPendingChannelId(id);
    try {
      const next: ReminderDraft = {
        ...reminder,
        channelIds: reminder.channelIds.filter((c) => c !== id),
      };
      await onSave(next);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "削除に失敗しました");
    } finally {
      setPendingChannelId(null);
    }
  };

  if (wsLoading) {
    return <div style={{ padding: "1rem" }}>読み込み中...</div>;
  }
  if (wsError) {
    return (
      <div style={{ padding: "1rem", color: "#dc2626" }}>エラー: {wsError}</div>
    );
  }

  return (
    <div>
      {/* 影響するチャンネル一覧 */}
      <div style={{ marginBottom: "2rem" }}>
        <h3 style={s.sectionHeading}>
          影響するチャンネル ({registeredRows.length}件)
        </h3>
        <p style={s.desc}>
          ここに登録された各チャンネルへ、このリマインドが指定の曜日・時刻に投稿されます。
        </p>
        {registeredRows.length === 0 ? (
          <div style={s.empty}>
            まだチャンネルが登録されていません。下から追加してください。
          </div>
        ) : (
          <div style={{ display: "grid", gap: "0.5rem" }}>
            {registeredRows.map((r) => (
              <div key={r.id} style={s.registeredRow}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <strong>{r.name ? `#${r.name}` : "(チャンネル名不明)"}</strong>
                  <div style={s.meta}>{r.id}</div>
                </div>
                <button
                  onClick={() => handleRemove(r.id)}
                  disabled={disabled || pendingChannelId === r.id}
                  style={s.removeBtn}
                  aria-label={`チャンネル ${r.name ?? r.id} を外す`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 追加 UI: ChannelPicker に委譲 */}
      <div>
        <h3 style={s.sectionHeading}>チャンネルを追加</h3>
        <ChannelPicker
          workspaces={workspaces}
          selectedWorkspaceId={selectedWorkspaceId}
          onWorkspaceChange={setSelectedWorkspaceId}
          fetchChannels={fetchChannelsForPicker}
          registeredChannelIds={registeredIdSet}
          onAdd={handleAdd}
          disabled={disabled}
          channelNameAsButton
        />
      </div>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  sectionHeading: { margin: "0 0 0.5rem", fontSize: "1rem" },
  desc: { fontSize: "0.875rem", color: "#6b7280", margin: "0 0 0.75rem" },
  registeredRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    padding: "0.75rem",
    border: "1px solid #e5e7eb",
    borderRadius: "0.375rem",
    background: "white",
    flexWrap: "wrap",
  },
  meta: { fontSize: "0.75rem", color: "#6b7280", marginTop: "0.125rem" },
  empty: {
    padding: "1.5rem",
    textAlign: "center",
    color: "#6b7280",
    border: "1px dashed #d1d5db",
    borderRadius: "0.5rem",
    fontSize: "0.875rem",
  },
  removeBtn: {
    background: "white",
    color: "#dc2626",
    border: "1px solid #dc2626",
    width: "1.75rem",
    height: "1.75rem",
    borderRadius: "0.25rem",
    cursor: "pointer",
    fontSize: "1rem",
    lineHeight: 1,
    padding: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
};
