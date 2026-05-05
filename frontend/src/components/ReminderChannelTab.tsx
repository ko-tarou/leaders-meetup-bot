import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { api } from "../api";
import type { Workspace } from "../types";
import type { ReminderDraft } from "./ReminderCard";

// Sprint 23 PR-B/C: weekly_reminder 詳細画面の「チャンネル管理」タブ。
// task_management の ChannelManagementSection と同等の UX:
// workspace selector + 検索 + ページネーション付きで bot 参加中チャンネルを
// 一覧表示し、+ 追加 / × 削除 を即時保存する。
//
// データモデルの違い:
// - task_management: meetings テーブルの行を作る/削除する
// - weekly_reminder: 1 reminder の channelIds 配列を更新する
//
// 操作対象が異なるため共通コンポーネント化はせず、UI は強くなぞる方針で書き直す。

const PAGE_SIZE = 20;

type SlackChannel = { id: string; name: string };

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
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [wsLoading, setWsLoading] = useState(true);
  const [wsError, setWsError] = useState<string | null>(null);

  // 追加 UI 用
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>("");
  const [availableChannels, setAvailableChannels] = useState<SlackChannel[]>(
    [],
  );
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
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

  // workspace 切替で slack channels 再取得
  useEffect(() => {
    if (!selectedWorkspaceId) {
      setAvailableChannels([]);
      return;
    }
    let cancelled = false;
    setChannelsLoading(true);
    api
      .getSlackChannels(selectedWorkspaceId)
      .then((list) => {
        if (cancelled) return;
        setAvailableChannels(Array.isArray(list) ? list : []);
        setChannelsLoading(false);
        setPage(1);
      })
      .catch(() => {
        if (cancelled) return;
        setAvailableChannels([]);
        setChannelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedWorkspaceId]);

  // 検索文字変更時は1ページ目へ
  useEffect(() => {
    setPage(1);
  }, [search]);

  const channelById = useMemo(() => {
    const m = new Map<string, SlackChannel>();
    for (const c of availableChannels) m.set(c.id, c);
    return m;
  }, [availableChannels]);

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

  // 利用可能チャンネル: 未登録のもの + 検索フィルタ
  const filteredChannels = useMemo(() => {
    const q = search.trim().toLowerCase();
    return availableChannels
      .filter((c) => !registeredIdSet.has(c.id))
      .filter((c) => !q || c.name.toLowerCase().includes(q));
  }, [availableChannels, registeredIdSet, search]);

  const totalPages = Math.max(1, Math.ceil(filteredChannels.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pagedChannels = filteredChannels.slice(
    (safePage - 1) * PAGE_SIZE,
    safePage * PAGE_SIZE,
  );

  const handleAdd = async (channel: SlackChannel) => {
    setPendingChannelId(channel.id);
    try {
      const next: ReminderDraft = {
        ...reminder,
        channelIds: [...reminder.channelIds, channel.id],
      };
      await onSave(next);
    } catch (e) {
      alert(e instanceof Error ? e.message : "追加に失敗しました");
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
      alert(e instanceof Error ? e.message : "削除に失敗しました");
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

      {/* 追加 UI */}
      <div>
        <h3 style={s.sectionHeading}>チャンネルを追加</h3>
        {workspaces.length === 0 ? (
          <div style={s.empty}>
            ワークスペースが未登録です。先にワークスペースを追加してください。
          </div>
        ) : (
          <>
            <div style={s.controlsRow}>
              <select
                value={selectedWorkspaceId}
                onChange={(e) => setSelectedWorkspaceId(e.target.value)}
                style={{ ...s.field, minWidth: "180px", flex: "0 0 auto" }}
                disabled={disabled}
              >
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="チャンネル名で検索..."
                style={{ ...s.field, flex: 1, minWidth: "200px" }}
                disabled={disabled}
              />
            </div>

            {channelsLoading ? (
              <div style={s.hint}>チャンネル読み込み中...</div>
            ) : pagedChannels.length === 0 ? (
              <div style={s.hint}>
                {search
                  ? "該当するチャンネルがありません"
                  : "追加可能なチャンネルがありません（既に全て登録済みか、bot が招待されていない可能性があります）"}
              </div>
            ) : (
              <div style={{ display: "grid", gap: "0.25rem" }}>
                {pagedChannels.map((c) => (
                  <div key={c.id} style={s.channelRow}>
                    <button
                      type="button"
                      onClick={() => handleAdd(c)}
                      disabled={disabled || pendingChannelId === c.id}
                      style={s.channelNameBtn}
                      title="クリックで追加"
                    >
                      #{c.name}
                    </button>
                    <span style={s.channelId}>{c.id}</span>
                    <button
                      onClick={() => handleAdd(c)}
                      disabled={disabled || pendingChannelId === c.id}
                      style={s.addBtn}
                    >
                      {pendingChannelId === c.id ? "追加中..." : "+ 追加"}
                    </button>
                  </div>
                ))}
              </div>
            )}

            {totalPages > 1 && (
              <Pagination
                page={safePage}
                totalPages={totalPages}
                onChange={setPage}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Pagination({
  page,
  totalPages,
  onChange,
}: {
  page: number;
  totalPages: number;
  onChange: (n: number) => void;
}) {
  const visibleCount = Math.min(totalPages, 10);
  return (
    <div style={s.pagination}>
      <button
        onClick={() => onChange(Math.max(1, page - 1))}
        disabled={page === 1}
        style={s.pageBtn}
      >
        ← 前へ
      </button>
      {Array.from({ length: visibleCount }).map((_, i) => {
        const n = i + 1;
        const active = n === page;
        return (
          <button
            key={n}
            onClick={() => onChange(n)}
            style={{
              ...s.pageBtn,
              background: active ? "#2563eb" : "white",
              color: active ? "white" : "#374151",
              borderColor: active ? "#2563eb" : "#d1d5db",
            }}
          >
            {n}
          </button>
        );
      })}
      {totalPages > 10 && (
        <span style={{ color: "#6b7280", fontSize: "0.875rem" }}>
          ... 全 {totalPages} ページ
        </span>
      )}
      <button
        onClick={() => onChange(Math.min(totalPages, page + 1))}
        disabled={page === totalPages}
        style={s.pageBtn}
      >
        次へ →
      </button>
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
  channelRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    padding: "0.5rem 0.75rem",
    border: "1px solid #e5e7eb",
    borderRadius: "0.25rem",
    background: "white",
  },
  channelNameBtn: {
    flex: 1,
    minWidth: 0,
    background: "transparent",
    border: "none",
    color: "#2563eb",
    cursor: "pointer",
    textAlign: "left",
    padding: 0,
    fontSize: "0.875rem",
  },
  channelId: { fontSize: "0.75rem", color: "#6b7280" },
  controlsRow: {
    display: "flex",
    gap: "0.5rem",
    marginBottom: "0.75rem",
    flexWrap: "wrap",
  },
  field: {
    padding: "0.4rem 0.6rem",
    border: "1px solid #d1d5db",
    borderRadius: "0.25rem",
    fontSize: "0.875rem",
    boxSizing: "border-box",
  },
  empty: {
    padding: "1.5rem",
    textAlign: "center",
    color: "#6b7280",
    border: "1px dashed #d1d5db",
    borderRadius: "0.5rem",
    fontSize: "0.875rem",
  },
  hint: {
    padding: "1rem",
    color: "#6b7280",
    textAlign: "center",
    fontSize: "0.875rem",
  },
  addBtn: {
    background: "#2563eb",
    color: "white",
    border: "none",
    padding: "0.25rem 0.75rem",
    borderRadius: "0.25rem",
    cursor: "pointer",
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
  pagination: {
    marginTop: "1rem",
    display: "flex",
    gap: "0.25rem",
    alignItems: "center",
    justifyContent: "center",
    flexWrap: "wrap",
  },
  pageBtn: {
    padding: "0.25rem 0.6rem",
    border: "1px solid #d1d5db",
    background: "white",
    borderRadius: "0.25rem",
    cursor: "pointer",
    minWidth: "2rem",
    fontSize: "0.875rem",
  },
};
