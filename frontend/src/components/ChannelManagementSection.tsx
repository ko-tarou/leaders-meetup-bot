import { useEffect, useMemo, useState } from "react";
import type { EventActionType, Meeting, Workspace } from "../types";
import { api } from "../api";

// Sprint 13 PR3: タスク管理アクションの「チャンネル管理」サブタブ。
// 旧 TaskManagementSettings + AddChannelModal を統合し、
// ページ内インラインで「検索 + リスト + ページネーション」UI に置換する。
// Sprint 15 PR2: actionType prop で task_management / pr_review_list を切替。
//   sticky 状態判定と enable/disable API を分岐する。

const PAGE_SIZE = 20;

type Props = {
  eventId: string;
  actionType: EventActionType;
};

type SlackChannel = { id: string; name: string };

// actionType ごとの sticky bot ラベル。MVP では「sticky bot」表記を踏襲しつつ
// 説明文だけ機能名を分岐する。
const STICKY_DESC: Record<string, string> = {
  task_management:
    "ここに登録された各チャンネルでタスク管理機能（タスク作成・sticky bot）が動作します。",
  pr_review_list:
    "ここに登録された各チャンネルで PR レビュー機能（一覧表示・sticky bot）が動作します。",
};

export function ChannelManagementSection({ eventId, actionType }: Props) {
  // 登録済みチャンネル
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pendingMeetingId, setPendingMeetingId] = useState<string | null>(null);

  // 追加 UI 用
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>("");
  const [availableChannels, setAvailableChannels] = useState<SlackChannel[]>(
    [],
  );
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState<string | null>(null);

  // 初期 fetch（meetings + workspaces）
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([api.getMeetings(eventId), api.workspaces.list()])
      .then(([ms, ws]) => {
        if (cancelled) return;
        const meetingsList = Array.isArray(ms) ? ms : [];
        const wsList = Array.isArray(ws) ? ws : [];
        setMeetings(meetingsList);
        setWorkspaces(wsList);
        setSelectedWorkspaceId((cur) => {
          if (cur) return cur;
          return wsList[0]?.id ?? "";
        });
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "読み込みに失敗しました");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, refreshKey]);

  // workspace 切替時に slack channels 再取得
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

  // 既登録 channel_id（選択中 workspace）
  const registeredChannelIds = useMemo(
    () =>
      new Set(
        meetings
          .filter((m) => m.workspaceId === selectedWorkspaceId)
          .map((m) => m.channelId),
      ),
    [meetings, selectedWorkspaceId],
  );

  const filteredChannels = useMemo(() => {
    const q = search.trim().toLowerCase();
    return availableChannels
      .filter((c) => !registeredChannelIds.has(c.id))
      .filter((c) => !q || c.name.toLowerCase().includes(q));
  }, [availableChannels, registeredChannelIds, search]);

  const totalPages = Math.max(1, Math.ceil(filteredChannels.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pagedChannels = filteredChannels.slice(
    (safePage - 1) * PAGE_SIZE,
    safePage * PAGE_SIZE,
  );

  const wsName = (id?: string | null) =>
    workspaces.find((w) => w.id === id)?.name ?? "不明な workspace";

  // actionType ごとに sticky 有効/無効を判定
  const getStickyEnabled = (m: Meeting): boolean => {
    if (actionType === "task_management") return !!m.taskBoardTs;
    if (actionType === "pr_review_list") return !!m.prReviewBoardTs;
    return false;
  };

  // actionType ごとに sticky enable/disable API を選択
  const enableSticky = (meetingId: string) => {
    if (actionType === "task_management") return api.enableTaskBoard(meetingId);
    if (actionType === "pr_review_list")
      return api.enablePRReviewBoard(meetingId);
    throw new Error(`unsupported actionType: ${actionType}`);
  };
  const disableSticky = (meetingId: string) => {
    if (actionType === "task_management") return api.disableTaskBoard(meetingId);
    if (actionType === "pr_review_list")
      return api.disablePRReviewBoard(meetingId);
    throw new Error(`unsupported actionType: ${actionType}`);
  };

  const handleToggleSticky = async (m: Meeting) => {
    setPendingMeetingId(m.id);
    try {
      const r = getStickyEnabled(m)
        ? await disableSticky(m.id)
        : await enableSticky(m.id);
      if (!r.ok) throw new Error(r.error ?? "切替に失敗しました");
      setRefreshKey((k) => k + 1);
    } catch (e) {
      alert(e instanceof Error ? e.message : "切替に失敗しました");
    } finally {
      setPendingMeetingId(null);
    }
  };

  // Sprint 18 PR1: sticky board の手動リフレッシュ。
  // 古いメッセージを削除して最新機能（start_at トグル / LGTM 等）が反映された
  // 新メッセージを post する。誤操作防止のため confirm を挟む。
  // Sprint 18 PR2: 診断版に対応。delete / post の各結果を alert で表示し、
  // 「ok=true なのに Slack に出ない」「silent fail」を運用画面で特定可能に。
  // backend は診断情報を含むが api.ts の型は ts/error しか持たないため
  // ローカル型で受け直す。
  type RefreshDiagnostics = {
    ok: boolean;
    error?: string;
    oldTs?: string;
    deleteError?: string;
    postError?: string;
    newTs?: string;
  };
  const handleRefresh = async (m: Meeting) => {
    if (!getStickyEnabled(m)) {
      alert("sticky bot が無効です。先に有効化してください。");
      return;
    }
    if (
      !confirm(
        `「${m.name}」の sticky メッセージを削除して新しく投稿し直します。よろしいですか？`,
      )
    ) {
      return;
    }
    setPendingMeetingId(m.id);
    try {
      const raw =
        actionType === "task_management"
          ? await api.refreshTaskBoard(m.id)
          : actionType === "pr_review_list"
            ? await api.refreshPRReviewBoard(m.id)
            : null;
      if (!raw) {
        throw new Error(`unsupported actionType: ${actionType}`);
      }
      const r = raw as unknown as RefreshDiagnostics;
      setRefreshKey((k) => k + 1);

      // 診断情報を整形して表示
      const deleteLine = r.deleteError
        ? `削除: NG ${r.deleteError}`
        : "削除: OK";
      const postLine = r.postError
        ? `投稿: NG ${r.postError}`
        : `投稿: OK (ts=${r.newTs ?? "?"})`;
      alert(
        `ボード更新結果:\n${deleteLine}\n${postLine}\n\n旧 ts: ${r.oldTs ?? "?"}`,
      );
    } catch (e) {
      alert(e instanceof Error ? e.message : "更新に失敗しました");
    } finally {
      setPendingMeetingId(null);
    }
  };

  const handleRemove = async (m: Meeting) => {
    if (
      !confirm(
        `「${m.name}」を影響チャンネルから外しますか？\n（sticky bot を有効化したまま削除すると Slack 上のメッセージは残ります）`,
      )
    ) {
      return;
    }
    setPendingMeetingId(m.id);
    try {
      await api.deleteMeeting(m.id);
      setRefreshKey((k) => k + 1);
    } catch (e) {
      alert(e instanceof Error ? e.message : "削除に失敗しました");
    } finally {
      setPendingMeetingId(null);
    }
  };

  const handleAdd = async (channel: SlackChannel) => {
    if (!selectedWorkspaceId) return;
    setAdding(channel.id);
    try {
      const created = await api.createMeeting({
        name: channel.name,
        channelId: channel.id,
        eventId,
        workspaceId: selectedWorkspaceId,
      });
      // sticky をデフォルトで即有効化（失敗しても追加自体は成立させる）
      try {
        await enableSticky(created.id);
      } catch (e) {
        console.warn("sticky 有効化失敗:", e);
      }
      setRefreshKey((k) => k + 1);
    } catch (e) {
      alert(e instanceof Error ? e.message : "追加に失敗しました");
    } finally {
      setAdding(null);
    }
  };

  if (loading) return <div style={{ padding: "1rem" }}>読み込み中...</div>;
  if (error) {
    return (
      <div style={{ padding: "1rem", color: "#dc2626" }}>エラー: {error}</div>
    );
  }

  return (
    <div>
      {/* 影響するチャンネル一覧 */}
      <div style={{ marginBottom: "2rem" }}>
        <h3 style={sectionHeadingStyle}>
          影響するチャンネル ({meetings.length}件)
        </h3>
        <p style={descStyle}>
          {STICKY_DESC[actionType] ??
            "ここに登録された各チャンネルでこのアクションの sticky bot が動作します。"}
        </p>
        {meetings.length === 0 ? (
          <div style={emptyStyle}>
            まだチャンネルが登録されていません。下から追加してください。
          </div>
        ) : (
          <div style={{ display: "grid", gap: "0.5rem" }}>
            {meetings.map((m) => {
              const isEnabled = getStickyEnabled(m);
              return (
                <div key={m.id} style={meetingRowStyle}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <strong>{m.name}</strong>
                    <div style={metaStyle}>
                      [{wsName(m.workspaceId)}] {m.channelId}
                    </div>
                  </div>
                  <label
                    style={{
                      ...toggleLabelStyle,
                      color: isEnabled ? "#16a34a" : "#6b7280",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={isEnabled}
                      onChange={() => handleToggleSticky(m)}
                      disabled={pendingMeetingId === m.id}
                    />
                    sticky bot {isEnabled ? "ON" : "OFF"}
                  </label>
                  <button
                    onClick={() => handleRefresh(m)}
                    disabled={pendingMeetingId === m.id || !isEnabled}
                    style={refreshBtnStyle}
                    title={
                      isEnabled
                        ? "古いメッセージを削除して最新機能で再投稿"
                        : "sticky bot を有効化してください"
                    }
                  >
                    🔄 更新
                  </button>
                  <button
                    onClick={() => handleRemove(m)}
                    disabled={pendingMeetingId === m.id}
                    style={removeBtnStyle}
                  >
                    削除
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 追加 UI */}
      <div>
        <h3 style={sectionHeadingStyle}>チャンネルを追加</h3>
        {workspaces.length === 0 ? (
          <div style={emptyStyle}>
            ワークスペースが未登録です。先にワークスペースを追加してください。
          </div>
        ) : (
          <>
            <div style={controlsRowStyle}>
              <select
                value={selectedWorkspaceId}
                onChange={(e) => setSelectedWorkspaceId(e.target.value)}
                style={{ ...fieldStyle, minWidth: "180px", flex: "0 0 auto" }}
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
                style={{ ...fieldStyle, flex: 1, minWidth: "200px" }}
              />
            </div>

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
                    <span style={{ flex: 1, minWidth: 0 }}>#{c.name}</span>
                    <span style={channelIdStyle}>{c.id}</span>
                    <button
                      onClick={() => handleAdd(c)}
                      disabled={adding === c.id}
                      style={addBtnStyle}
                    >
                      {adding === c.id ? "追加中..." : "+ 追加"}
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
  // 1...10 を直接出し、それ以上は省略表示。最初/最後ボタンは省略してシンプルに。
  const visibleCount = Math.min(totalPages, 10);
  return (
    <div style={paginationStyle}>
      <button
        onClick={() => onChange(Math.max(1, page - 1))}
        disabled={page === 1}
        style={pageBtnStyle}
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
              ...pageBtnStyle,
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
        style={pageBtnStyle}
      >
        次へ →
      </button>
    </div>
  );
}

const sectionHeadingStyle: React.CSSProperties = {
  margin: "0 0 0.5rem",
  fontSize: "1rem",
};

const descStyle: React.CSSProperties = {
  fontSize: "0.875rem",
  color: "#6b7280",
  margin: "0 0 0.75rem",
};

const meetingRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  padding: "0.75rem",
  border: "1px solid #e5e7eb",
  borderRadius: "0.375rem",
  background: "white",
  flexWrap: "wrap",
};

const metaStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  color: "#6b7280",
  marginTop: "0.125rem",
};

const toggleLabelStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.25rem",
  fontSize: "0.875rem",
};

const channelRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  padding: "0.5rem 0.75rem",
  border: "1px solid #e5e7eb",
  borderRadius: "0.25rem",
  background: "white",
};

const channelIdStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  color: "#6b7280",
};

const controlsRowStyle: React.CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  marginBottom: "0.75rem",
  flexWrap: "wrap",
};

const fieldStyle: React.CSSProperties = {
  padding: "0.4rem 0.6rem",
  border: "1px solid #d1d5db",
  borderRadius: "0.25rem",
  fontSize: "0.875rem",
  boxSizing: "border-box",
};

const emptyStyle: React.CSSProperties = {
  padding: "1.5rem",
  textAlign: "center",
  color: "#6b7280",
  border: "1px dashed #d1d5db",
  borderRadius: "0.5rem",
  fontSize: "0.875rem",
};

const hintStyle: React.CSSProperties = {
  padding: "1rem",
  color: "#6b7280",
  textAlign: "center",
  fontSize: "0.875rem",
};

const addBtnStyle: React.CSSProperties = {
  background: "#2563eb",
  color: "white",
  border: "none",
  padding: "0.25rem 0.75rem",
  borderRadius: "0.25rem",
  cursor: "pointer",
  fontSize: "0.875rem",
};

const removeBtnStyle: React.CSSProperties = {
  padding: "0.25rem 0.6rem",
  border: "1px solid #fecaca",
  background: "white",
  color: "#dc2626",
  borderRadius: "0.25rem",
  cursor: "pointer",
  fontSize: "0.8125rem",
};

const refreshBtnStyle: React.CSSProperties = {
  padding: "0.25rem 0.6rem",
  border: "1px solid #d1d5db",
  background: "white",
  color: "#374151",
  borderRadius: "0.25rem",
  cursor: "pointer",
  fontSize: "0.8125rem",
};

const paginationStyle: React.CSSProperties = {
  marginTop: "1rem",
  display: "flex",
  gap: "0.25rem",
  alignItems: "center",
  justifyContent: "center",
  flexWrap: "wrap",
};

const pageBtnStyle: React.CSSProperties = {
  padding: "0.25rem 0.6rem",
  border: "1px solid #d1d5db",
  background: "white",
  borderRadius: "0.25rem",
  cursor: "pointer",
  minWidth: "2rem",
  fontSize: "0.875rem",
};
