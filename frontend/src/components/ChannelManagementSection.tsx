import { useEffect, useMemo, useState } from "react";
import type { EventActionType, Meeting, Workspace } from "../types";
import { api } from "../api";
import { ChannelPicker, type SlackChannelLike } from "./ui/ChannelPicker";
import { useToast } from "./ui/Toast";
import { useConfirm } from "./ui/ConfirmDialog";

// Sprint 13 PR3: タスク管理アクションの「チャンネル管理」サブタブ。
// 旧 TaskManagementSettings + AddChannelModal を統合し、
// ページ内インラインで「検索 + リスト + ページネーション」UI に置換する。
// Sprint 15 PR2: actionType prop で task_management / pr_review_list を切替。
//   sticky 状態判定と enable/disable API を分岐する。
// Sprint 005-11: 「workspace selector + 検索 + 候補リスト + ページング」を
//   ui/ChannelPicker.tsx に切り出した。本体は「登録済みチャンネル一覧
//   (sticky toggle / refresh / delete)」+ Meeting 状態管理に責務を絞る。

type Props = {
  eventId: string;
  actionType: EventActionType;
};

// actionType ごとの sticky bot ラベル。MVP では「sticky bot」表記を踏襲しつつ
// 説明文だけ機能名を分岐する。
const STICKY_DESC: Record<string, string> = {
  task_management:
    "ここに登録された各チャンネルでタスク管理機能（タスク作成・sticky bot）が動作します。",
  pr_review_list:
    "ここに登録された各チャンネルで PR レビュー機能（一覧表示・sticky bot）が動作します。",
};

export function ChannelManagementSection({ eventId, actionType }: Props) {
  const toast = useToast();
  const { confirm } = useConfirm();
  // 登録済みチャンネル
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pendingMeetingId, setPendingMeetingId] = useState<string | null>(null);

  // ChannelPicker 用の選択中 workspace
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>("");

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

  // 既登録 channel_id（選択中 workspace）。ChannelPicker の候補除外用。
  const registeredChannelIds = useMemo(
    () =>
      new Set(
        meetings
          .filter((m) => m.workspaceId === selectedWorkspaceId)
          .map((m) => m.channelId),
      ),
    [meetings, selectedWorkspaceId],
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
      toast.error(e instanceof Error ? e.message : "切替に失敗しました");
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
      toast.error("sticky bot が無効です。先に有効化してください。");
      return;
    }
    const ok = await confirm({
      message: `「${m.name}」の sticky メッセージを削除して新しく投稿し直します。よろしいですか？`,
      confirmLabel: "更新",
    });
    if (!ok) {
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
      toast.info(
        `ボード更新結果:\n${deleteLine}\n${postLine}\n\n旧 ts: ${r.oldTs ?? "?"}`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "更新に失敗しました");
    } finally {
      setPendingMeetingId(null);
    }
  };

  const handleRemove = async (m: Meeting) => {
    const ok = await confirm({
      message: `「${m.name}」を影響チャンネルから外しますか？\n（sticky bot を有効化したまま削除すると Slack 上のメッセージは残ります）`,
      variant: "danger",
      confirmLabel: "削除",
    });
    if (!ok) {
      return;
    }
    setPendingMeetingId(m.id);
    try {
      await api.deleteMeeting(m.id);
      setRefreshKey((k) => k + 1);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "削除に失敗しました");
    } finally {
      setPendingMeetingId(null);
    }
  };

  // ChannelPicker から呼ばれる add ハンドラ。
  // createMeeting + sticky 有効化を一括で行う。
  // sticky 有効化に失敗しても追加自体は成立させる（既存挙動を維持）。
  const handleAdd = async (channel: SlackChannelLike) => {
    if (!selectedWorkspaceId) return;
    try {
      const created = await api.createMeeting({
        name: channel.name,
        channelId: channel.id,
        eventId,
        workspaceId: selectedWorkspaceId,
      });
      try {
        await enableSticky(created.id);
      } catch (e) {
        console.warn("sticky 有効化失敗:", e);
      }
      setRefreshKey((k) => k + 1);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "追加に失敗しました");
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

      {/* 追加 UI: ChannelPicker に委譲 */}
      <div>
        <h3 style={sectionHeadingStyle}>チャンネルを追加</h3>
        <ChannelPicker
          workspaces={workspaces}
          selectedWorkspaceId={selectedWorkspaceId}
          onWorkspaceChange={setSelectedWorkspaceId}
          fetchChannels={api.getSlackChannels}
          registeredChannelIds={registeredChannelIds}
          onAdd={handleAdd}
        />
      </div>
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

const emptyStyle: React.CSSProperties = {
  padding: "1.5rem",
  textAlign: "center",
  color: "#6b7280",
  border: "1px dashed #d1d5db",
  borderRadius: "0.5rem",
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
