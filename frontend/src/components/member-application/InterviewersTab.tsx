import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { api } from "../../api";
import type { EventAction, InterviewerSummary } from "../../types";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toast";
import { useConfirm } from "../ui/ConfirmDialog";
import { colors } from "../../styles/tokens";
import { InterviewerEntryViewer } from "./InterviewerEntryViewer";

// 005-interviewer-simplify / PR #139:
// member_application action の「面接官」サブタブ。
//
// 旧仕様 (Sprint 25): admin が面接官を 1 人ずつ追加し、各人ごとに招待 URL を
//   発行 → メールで送る運用だった。
// 新仕様: action ごとに 1 つの form URL を共有する。面接官は公開フォームから
//   名前 + 利用可能 slot を提出 (name で upsert)。admin は閲覧 + 削除のみ。

type Props = {
  eventId: string;
  action: EventAction;
};

export function InterviewersTab({ eventId, action }: Props) {
  const toast = useToast();
  const { confirm } = useConfirm();
  const [entries, setEntries] = useState<InterviewerSummary[] | null>(null);
  const [formUrl, setFormUrl] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setFormUrl("");
    setError(null);
    setRefreshing(true);
    Promise.all([
      api.interviewers.list(eventId, action.id),
      api.interviewers.getFormToken(eventId, action.id),
    ])
      .then(([list, tokenRes]) => {
        if (cancelled) return;
        setEntries(Array.isArray(list) ? list : []);
        setFormUrl(tokenRes.formUrl);
      })
      .catch((e) => {
        if (cancelled) return;
        setEntries([]);
        setError(e instanceof Error ? e.message : "読み込みに失敗しました");
      })
      .finally(() => {
        if (cancelled) return;
        setRefreshing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, action.id, refreshKey]);

  const handleCopy = async () => {
    if (!formUrl) return;
    try {
      await navigator.clipboard.writeText(formUrl);
      toast.success("URL をコピーしました");
    } catch {
      toast.error("コピーに失敗しました");
    }
  };

  const handleRotate = async () => {
    const ok = await confirm({
      title: "URL を再生成しますか？",
      message:
        "現在の URL を無効にして新しい URL を発行します。\n旧 URL を共有済みの面接官にはアクセスできなくなります。",
      variant: "danger",
      confirmLabel: "再生成",
    });
    if (!ok) return;
    setRotating(true);
    try {
      const res = await api.interviewers.rotateFormToken(eventId, action.id);
      setFormUrl(res.formUrl);
      toast.success("URL を再生成しました");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "再生成に失敗しました");
    } finally {
      setRotating(false);
    }
  };

  const handleDelete = async (entry: InterviewerSummary) => {
    const ok = await confirm({
      message: `「${entry.name}」のエントリーを削除しますか？登録された slot も併せて削除されます。`,
      variant: "danger",
      confirmLabel: "削除",
    });
    if (!ok) return;
    try {
      await api.interviewers.delete(eventId, action.id, entry.id);
      toast.success("削除しました");
      setRefreshKey((k) => k + 1);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "削除に失敗しました");
    }
  };

  // 詳細表示: 1 entry の slots 閲覧
  if (viewingId) {
    return (
      <InterviewerEntryViewer
        eventId={eventId}
        actionId={action.id}
        entryId={viewingId}
        onBack={() => setViewingId(null)}
      />
    );
  }

  return (
    <div style={{ padding: "1rem" }}>
      <h3 style={{ margin: 0, marginBottom: "0.75rem" }}>面接官</h3>

      {/* URL 共有セクション */}
      <section style={urlBoxStyle} aria-label="面接官フォーム URL">
        <div style={urlLabelStyle}>面接官フォーム URL</div>
        <p style={urlDescStyle}>
          このリンクを面接官に共有してください。誰でもアクセスし、名前と利用可能な日時を入力できます。
          同じ名前で再度フォームを開けば内容は上書きされます。
        </p>
        <div style={urlRowStyle}>
          <input
            readOnly
            value={formUrl}
            placeholder={refreshing ? "読み込み中..." : ""}
            style={urlInputStyle}
            aria-label="面接官フォーム URL"
            onFocus={(e) => e.currentTarget.select()}
          />
          <Button
            size="sm"
            onClick={handleCopy}
            disabled={!formUrl || refreshing}
          >
            コピー
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={handleRotate}
            disabled={!formUrl || refreshing || rotating}
            isLoading={rotating}
          >
            URL を再生成
          </Button>
        </div>
      </section>

      {/* エントリー一覧 */}
      <section style={{ marginTop: "1.5rem" }}>
        <h4 style={{ margin: "0 0 0.5rem", fontSize: "0.95rem" }}>
          提出済みエントリー
        </h4>
        {error && (
          <div role="alert" style={errorStyle}>
            {error}
          </div>
        )}
        {entries === null ? (
          <div style={{ color: colors.textSecondary }}>読み込み中...</div>
        ) : entries.length === 0 ? (
          <div style={emptyStyle}>
            まだエントリーはありません。上の URL を面接官に共有してください。
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>名前</th>
                  <th style={thStyle}>登録 slot 数</th>
                  <th style={thStyle}>最終更新</th>
                  <th style={thStyle}>操作</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td style={tdStyle}>{e.name}</td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>
                      {e.slotsCount}
                    </td>
                    <td style={tdStyle}>
                      {new Date(e.updatedAt).toLocaleString("ja-JP")}
                    </td>
                    <td style={tdStyle}>
                      <div style={{ display: "flex", gap: "0.25rem" }}>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setViewingId(e.id)}
                        >
                          詳細
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => handleDelete(e)}
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
      </section>
    </div>
  );
}

const urlBoxStyle: CSSProperties = {
  padding: "0.75rem 1rem",
  background: colors.primarySubtle,
  border: `1px solid ${colors.primary}`,
  borderRadius: "0.5rem",
};

const urlLabelStyle: CSSProperties = {
  fontSize: "0.75rem",
  color: colors.textSecondary,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
  marginBottom: "0.25rem",
};

const urlDescStyle: CSSProperties = {
  margin: "0 0 0.5rem",
  fontSize: "0.8rem",
  color: colors.text,
  lineHeight: 1.5,
};

const urlRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap",
};

const urlInputStyle: CSSProperties = {
  flex: "1 1 280px",
  minWidth: 0,
  padding: "0.4rem 0.5rem",
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: "0.375rem",
  fontFamily: "monospace",
  fontSize: "0.8rem",
  background: colors.background,
  color: colors.text,
};

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

const emptyStyle: CSSProperties = {
  padding: "1.5rem",
  textAlign: "center",
  color: colors.textSecondary,
  background: colors.surface,
  border: `1px dashed ${colors.border}`,
  borderRadius: "0.375rem",
};

const errorStyle: CSSProperties = {
  padding: "0.5rem 0.75rem",
  background: colors.dangerSubtle,
  color: colors.danger,
  borderRadius: "0.375rem",
  fontSize: "0.875rem",
  marginBottom: "0.75rem",
};
