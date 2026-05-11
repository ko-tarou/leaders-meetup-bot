import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Pagination } from "./Pagination";

// Sprint 005-11: ChannelManagementSection / ReminderChannelTab で重複していた
// 「workspace selector + 検索 + 候補チャンネル一覧 (ページング)」UI を共通化。
//
// 設計判断:
// 「既登録一覧」の見た目は呼び出し側で差が大きい
// (task_management: sticky toggle / refresh / delete の 3 ボタン、
//  weekly_reminder: × ボタンのみ) ため、共通化対象は「追加 UI」のみとする。
// 既登録一覧は呼び出し側で render する。
//
// ChannelPicker は以下を担う:
//   - workspace ドロップダウン
//   - 検索 input
//   - 候補チャンネル一覧 (ページング)
//   - 追加ボタン
//   - 「すでに登録済み ID」を受け取って候補から除外
//
// 保存処理は呼び出し側 (onAdd) に委譲する。

export type SlackChannelLike = { id: string; name: string };
export type WorkspaceLike = { id: string; name: string };

export type ChannelPickerProps = {
  /** 利用可能な workspace 一覧 */
  workspaces: WorkspaceLike[];
  /** 選択中 workspace ID */
  selectedWorkspaceId: string;
  /** workspace 切り替え時のコールバック */
  onWorkspaceChange: (id: string) => void;
  /**
   * 候補チャンネルを取得する関数。
   * 通常は `(id) => api.getSlackChannels(id)`。
   * workspace 切替時に都度呼ばれる。
   */
  fetchChannels: (workspaceId: string) => Promise<SlackChannelLike[]>;
  /**
   * すでに登録されている channel ID 集合。
   * 候補リストから除外するために使う。
   */
  registeredChannelIds: Set<string>;
  /** チャンネル追加時のコールバック (保存処理は呼び出し側) */
  onAdd: (channel: SlackChannelLike) => Promise<void> | void;
  /** 全体を disable するフラグ */
  disabled?: boolean;
  /** 1 ページあたり何件表示するか。既定 20 */
  pageSize?: number;
  /**
   * クリックでも追加できるチャンネル名表示にするか。
   * weekly_reminder 側は名前自体がボタン (リンク色) になっており、
   * task_management 側は単なる span 表示。挙動を維持するためにフラグで切替。
   */
  channelNameAsButton?: boolean;
  /** 候補リストの上に表示する追加コンテンツ (任意) */
  headerExtra?: ReactNode;
  /**
   * workspace ドロップダウンを非表示にするか。
   * 親が外側で workspace を選択済みの場合 (SingleChannelPicker 等) に使う。
   * workspaces は単一要素を渡しつつドロップダウンだけ隠す用途。
   */
  hideWorkspaceSelector?: boolean;
};

export function ChannelPicker({
  workspaces,
  selectedWorkspaceId,
  onWorkspaceChange,
  fetchChannels,
  registeredChannelIds,
  onAdd,
  disabled,
  pageSize = 20,
  channelNameAsButton = false,
  headerExtra,
  hideWorkspaceSelector = false,
}: ChannelPickerProps) {
  const [availableChannels, setAvailableChannels] = useState<SlackChannelLike[]>(
    [],
  );
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pendingChannelId, setPendingChannelId] = useState<string | null>(null);

  // workspace 切替で slack channels 再取得
  useEffect(() => {
    if (!selectedWorkspaceId) {
      setAvailableChannels([]);
      return;
    }
    let cancelled = false;
    setChannelsLoading(true);
    fetchChannels(selectedWorkspaceId)
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
    // fetchChannels は呼び出し側で stable に保つことを期待する
    // （API 関数の参照を直接渡す前提）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWorkspaceId]);

  // 検索文字変更時は1ページ目へ
  useEffect(() => {
    setPage(1);
  }, [search]);

  // 利用可能チャンネル: 未登録のもの + 検索フィルタ
  const filteredChannels = useMemo(() => {
    const q = search.trim().toLowerCase();
    return availableChannels
      .filter((c) => !registeredChannelIds.has(c.id))
      .filter((c) => !q || c.name.toLowerCase().includes(q));
  }, [availableChannels, registeredChannelIds, search]);

  const totalPages = Math.max(1, Math.ceil(filteredChannels.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pagedChannels = filteredChannels.slice(
    (safePage - 1) * pageSize,
    safePage * pageSize,
  );

  const handleAdd = async (channel: SlackChannelLike) => {
    setPendingChannelId(channel.id);
    try {
      await onAdd(channel);
    } finally {
      setPendingChannelId(null);
    }
  };

  if (workspaces.length === 0) {
    return (
      <div style={emptyStyle}>
        ワークスペースが未登録です。先にワークスペースを追加してください。
      </div>
    );
  }

  return (
    <>
      <div style={controlsRowStyle}>
        {!hideWorkspaceSelector && (
          <select
            value={selectedWorkspaceId}
            onChange={(e) => onWorkspaceChange(e.target.value)}
            style={{ ...fieldStyle, minWidth: "180px", flex: "0 0 auto" }}
            disabled={disabled}
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        )}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="チャンネル名で検索..."
          style={{ ...fieldStyle, flex: 1, minWidth: "200px" }}
          disabled={disabled}
        />
      </div>

      {headerExtra}

      {channelsLoading ? (
        <div style={hintStyle}>チャンネル読み込み中...</div>
      ) : pagedChannels.length === 0 ? (
        <div style={hintStyle}>
          {search
            ? "該当するチャンネルがありません"
            : "追加可能なチャンネルがありません（既に全て登録済みか、bot が招待されていない可能性があります）"}
        </div>
      ) : (
        <div style={{ display: "grid", gap: "0.25rem" }}>
          {pagedChannels.map((c) => (
            <div key={c.id} style={channelRowStyle}>
              {channelNameAsButton ? (
                <button
                  type="button"
                  onClick={() => handleAdd(c)}
                  disabled={disabled || pendingChannelId === c.id}
                  style={channelNameBtnStyle}
                  title="クリックで追加"
                >
                  #{c.name}
                </button>
              ) : (
                <span style={{ flex: 1, minWidth: 0 }}>#{c.name}</span>
              )}
              <span style={channelIdStyle}>{c.id}</span>
              <button
                onClick={() => handleAdd(c)}
                disabled={disabled || pendingChannelId === c.id}
                style={addBtnStyle}
              >
                {pendingChannelId === c.id ? "追加中..." : "+ 追加"}
              </button>
            </div>
          ))}
        </div>
      )}

      <Pagination
        currentPage={safePage}
        totalPages={totalPages}
        onPageChange={setPage}
      />
    </>
  );
}

const controlsRowStyle: CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  marginBottom: "0.75rem",
  flexWrap: "wrap",
};

const fieldStyle: CSSProperties = {
  padding: "0.4rem 0.6rem",
  border: "1px solid #d1d5db",
  borderRadius: "0.25rem",
  fontSize: "0.875rem",
  boxSizing: "border-box",
};

const channelRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  padding: "0.5rem 0.75rem",
  border: "1px solid #e5e7eb",
  borderRadius: "0.25rem",
  background: "white",
};

const channelNameBtnStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: "transparent",
  border: "none",
  color: "#2563eb",
  cursor: "pointer",
  textAlign: "left",
  padding: 0,
  fontSize: "0.875rem",
};

const channelIdStyle: CSSProperties = {
  fontSize: "0.75rem",
  color: "#6b7280",
};

const addBtnStyle: CSSProperties = {
  background: "#2563eb",
  color: "white",
  border: "none",
  padding: "0.25rem 0.75rem",
  borderRadius: "0.25rem",
  cursor: "pointer",
  fontSize: "0.875rem",
};

const hintStyle: CSSProperties = {
  padding: "1rem",
  color: "#6b7280",
  textAlign: "center",
  fontSize: "0.875rem",
};

const emptyStyle: CSSProperties = {
  padding: "1.5rem",
  textAlign: "center",
  color: "#6b7280",
  border: "1px dashed #d1d5db",
  borderRadius: "0.5rem",
  fontSize: "0.875rem",
};
