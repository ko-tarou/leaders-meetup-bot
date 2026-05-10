import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { api } from "../../api";
import type { EventAction, InterviewerWithMeta } from "../../types";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toast";
import { useConfirm } from "../ui/ConfirmDialog";
import { colors } from "../../styles/tokens";
import { AddInterviewerModal } from "./AddInterviewerModal";
import { InterviewerSlotsEditor } from "./InterviewerSlotsEditor";

// 005-interviewer / Sprint 25:
// member_application action の「面接官」サブタブ。
// - 面接官の一覧、追加、削除
// - 面接官個別の slot 編集（編集モードに切替）
//
// 編集モードでは InterviewerSlotsEditor を表示し、戻ると一覧に復帰する。
// 一覧の取得は list endpoint が slots/inviteUrl を同梱するため N+1 にならない。

type Props = {
  eventId: string;
  action: EventAction;
};

export function InterviewersTab({ eventId, action }: Props) {
  const toast = useToast();
  const { confirm } = useConfirm();
  const [interviewers, setInterviewers] = useState<InterviewerWithMeta[] | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setInterviewers(null);
    setError(null);
    api.interviewers
      .list(eventId, action.id)
      .then((list) => {
        if (cancelled) return;
        setInterviewers(Array.isArray(list) ? list : []);
      })
      .catch((e) => {
        if (cancelled) return;
        setInterviewers([]);
        setError(e instanceof Error ? e.message : "取得に失敗しました");
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, action.id, refreshKey]);

  const handleDelete = async (iv: InterviewerWithMeta) => {
    const ok = await confirm({
      message: `面接官「${iv.name}」を削除しますか？登録済みの slot も併せて削除されます。`,
      variant: "danger",
      confirmLabel: "削除",
    });
    if (!ok) return;
    try {
      await api.interviewers.delete(eventId, action.id, iv.id);
      toast.success("削除しました");
      setRefreshKey((k) => k + 1);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "削除に失敗しました");
    }
  };

  const handleCopyInvite = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("招待リンクをコピーしました");
    } catch {
      toast.error("コピーに失敗しました");
    }
  };

  // 編集モード: 1 名の slot 編集
  if (editingId && interviewers) {
    const target = interviewers.find((i) => i.id === editingId);
    if (!target) {
      // 編集中に削除等で見つからなくなった場合は一覧に戻す
      setEditingId(null);
      return null;
    }
    return (
      <InterviewerSlotsEditor
        title={`${target.name} さんの利用可能日時`}
        description="この面接官が面談可能な時間帯をクリックでマークしてください。応募ページの候補にはここで選択された時間帯が反映されます。"
        initialSlots={target.slots ?? []}
        onSave={async (slots) => {
          await api.interviewers.updateSlots(
            eventId,
            action.id,
            target.id,
            slots,
          );
          setRefreshKey((k) => k + 1);
        }}
        onBack={() => setEditingId(null)}
      />
    );
  }

  return (
    <div style={{ padding: "1rem" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          marginBottom: "1rem",
        }}
      >
        <h3 style={{ margin: 0 }}>面接官</h3>
        <Button onClick={() => setShowAdd(true)} size="sm">
          + 面接官追加
        </Button>
      </div>

      <p
        style={{
          color: colors.textSecondary,
          fontSize: "0.875rem",
          marginTop: 0,
          marginBottom: "1rem",
        }}
      >
        登録した面接官に「招待リンク」を送ると、各自が自分の利用可能日時を入力できます。
        応募ページには全員の slot を OR 結合した候補が表示されます。
      </p>

      {error && (
        <div role="alert" style={errorStyle}>
          {error}
        </div>
      )}

      {interviewers === null ? (
        <div style={{ color: colors.textSecondary }}>読み込み中...</div>
      ) : interviewers.length === 0 ? (
        <div
          style={{
            padding: "1.5rem",
            textAlign: "center",
            color: colors.textSecondary,
            background: colors.surface,
            border: `1px dashed ${colors.border}`,
            borderRadius: "0.375rem",
          }}
        >
          面接官がまだ登録されていません。「+ 面接官追加」から追加してください。
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>名前</th>
                <th style={thStyle}>メールアドレス</th>
                <th style={thStyle}>登録 slot 数</th>
                <th style={thStyle}>招待リンク</th>
                <th style={thStyle}>操作</th>
              </tr>
            </thead>
            <tbody>
              {interviewers.map((iv) => (
                <tr key={iv.id}>
                  <td style={tdStyle}>{iv.name}</td>
                  <td style={tdStyle}>
                    <span style={{ wordBreak: "break-all" }}>{iv.email}</span>
                  </td>
                  <td style={{ ...tdStyle, textAlign: "right" }}>
                    {iv.slots?.length ?? 0}
                  </td>
                  <td style={tdStyle}>
                    <button
                      type="button"
                      onClick={() => handleCopyInvite(iv.inviteUrl)}
                      style={linkBtnStyle}
                    >
                      コピー
                    </button>
                  </td>
                  <td style={tdStyle}>
                    <div style={{ display: "flex", gap: "0.25rem" }}>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setEditingId(iv.id)}
                      >
                        slot 編集
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => handleDelete(iv)}
                      >
                        削除
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showAdd && (
        <AddInterviewerModal
          eventId={eventId}
          actionId={action.id}
          onClose={() => setShowAdd(false)}
          onAdded={() => setRefreshKey((k) => k + 1)}
        />
      )}
    </div>
  );
}

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.875rem",
};

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "0.5rem 0.75rem",
  borderBottom: `1px solid ${colors.borderStrong}`,
  fontWeight: "bold",
  color: colors.textSecondary,
  fontSize: "0.8rem",
};

const tdStyle: CSSProperties = {
  padding: "0.625rem 0.75rem",
  borderBottom: `1px solid ${colors.border}`,
  verticalAlign: "middle",
};

const linkBtnStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  color: colors.primary,
  cursor: "pointer",
  padding: 0,
  fontSize: "0.875rem",
  textDecoration: "underline",
};

const errorStyle: CSSProperties = {
  padding: "0.5rem 0.75rem",
  background: colors.dangerSubtle,
  color: colors.danger,
  borderRadius: "0.375rem",
  fontSize: "0.875rem",
  marginBottom: "0.75rem",
};
