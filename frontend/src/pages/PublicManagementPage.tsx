import { useEffect, useState } from "react";
import { api } from "../api";
import type { Event, EventAction, EventActionType } from "../types";
import { useEvents } from "../contexts/EventContext";
import { useToast } from "../components/ui/Toast";
import { useConfirm } from "../components/ui/ConfirmDialog";
import { ACTION_META } from "../lib/eventTabs";
import { colors } from "../styles/tokens";

// 公開管理 (public-management): action 単位で公開 URL を発行する管理画面。
//
// セキュリティ警告 (POC):
//   - パスワード 'hackit' は BE 側で hardcode の固定値。
//   - 公開 URL は推測困難な 48 文字 hex token だが、パスワード共通なので注意。
//   - 本番運用前に強化が必要 (token 単位パスワード、有効期限、Rate limit 等)。

type Permission = "view" | "edit";

type TokenInfo = {
  viewToken: string | null;
  editToken: string | null;
  viewUrl: string | null;
  editUrl: string | null;
};

type ActionRow = {
  event: Event;
  action: EventAction;
  tokens: TokenInfo | null;
  loading: boolean;
};

export function PublicManagementPage() {
  const { events, loading: eventsLoading } = useEvents();
  const toast = useToast();
  const { confirm } = useConfirm();
  const [rows, setRows] = useState<ActionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (eventsLoading) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const allRows: ActionRow[] = [];
        for (const ev of events) {
          const actions = await api.events.actions.list(ev.id);
          for (const a of actions) {
            allRows.push({
              event: ev,
              action: a,
              tokens: null,
              loading: true,
            });
          }
        }
        if (cancelled) return;
        setRows(allRows);

        // token 情報は並行 fetch
        await Promise.all(
          allRows.map(async (row, idx) => {
            try {
              const info = await api.publicTokens.get(row.event.id, row.action.id);
              if (cancelled) return;
              setRows((prev) => {
                const next = [...prev];
                if (next[idx]) {
                  next[idx] = { ...next[idx], tokens: info, loading: false };
                }
                return next;
              });
            } catch (e) {
              if (cancelled) return;
              setRows((prev) => {
                const next = [...prev];
                if (next[idx]) {
                  next[idx] = { ...next[idx], tokens: null, loading: false };
                }
                return next;
              });
              console.error("[PublicManagement] fetch tokens failed", e);
            }
          }),
        );
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "読み込みに失敗");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [events, eventsLoading]);

  const updateTokens = (
    eventId: string,
    actionId: string,
    next: TokenInfo,
  ) => {
    setRows((prev) =>
      prev.map((r) =>
        r.event.id === eventId && r.action.id === actionId
          ? { ...r, tokens: next }
          : r,
      ),
    );
  };

  const handleGenerate = async (row: ActionRow, permission: Permission) => {
    const existing =
      permission === "view" ? row.tokens?.viewToken : row.tokens?.editToken;
    if (existing) {
      const ok = await confirm({
        message: `既存の ${permission === "view" ? "閲覧" : "編集"} URL を上書きしますか？\n(現在の URL は無効になります)`,
        variant: "danger",
        confirmLabel: "上書き発行",
      });
      if (!ok) return;
    }
    try {
      const res = await api.publicTokens.generate(
        row.event.id,
        row.action.id,
        permission,
      );
      const next: TokenInfo = {
        viewToken: permission === "view" ? res.token : (row.tokens?.viewToken ?? null),
        editToken: permission === "edit" ? res.token : (row.tokens?.editToken ?? null),
        viewUrl: permission === "view" ? res.url : (row.tokens?.viewUrl ?? null),
        editUrl: permission === "edit" ? res.url : (row.tokens?.editUrl ?? null),
      };
      updateTokens(row.event.id, row.action.id, next);
      toast.success(`${permission === "view" ? "閲覧" : "編集"} URL を発行しました`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "発行に失敗");
    }
  };

  const handleDelete = async (row: ActionRow, permission: Permission) => {
    const ok = await confirm({
      message: `${permission === "view" ? "閲覧" : "編集"} URL を無効化しますか？`,
      variant: "danger",
      confirmLabel: "無効化",
    });
    if (!ok) return;
    try {
      await api.publicTokens.delete(row.event.id, row.action.id, permission);
      const next: TokenInfo = {
        viewToken: permission === "view" ? null : (row.tokens?.viewToken ?? null),
        editToken: permission === "edit" ? null : (row.tokens?.editToken ?? null),
        viewUrl: permission === "view" ? null : (row.tokens?.viewUrl ?? null),
        editUrl: permission === "edit" ? null : (row.tokens?.editUrl ?? null),
      };
      updateTokens(row.event.id, row.action.id, next);
      toast.success("無効化しました");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "無効化に失敗");
    }
  };

  const copyToClipboard = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("URL をコピーしました");
    } catch {
      toast.error("コピーに失敗しました");
    }
  };

  if (loading || eventsLoading) {
    return <div style={{ padding: 16 }}>読み込み中...</div>;
  }
  if (error) {
    return (
      <div style={{ padding: 16, color: colors.danger }}>エラー: {error}</div>
    );
  }

  return (
    <div style={{ padding: "0 4px" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>公開管理</h1>
      <p
        style={{
          fontSize: 13,
          color: colors.textSecondary,
          lineHeight: 1.6,
          marginBottom: 8,
        }}
      >
        action 単位で公開 URL を発行します。パスワード <code style={codeStyle}>hackit</code>{" "}
        を入力すれば誰でも admin UI にアクセス可能です。
      </p>
      <div
        style={{
          fontSize: 12,
          color: colors.warning,
          background: colors.warningSubtle,
          padding: "8px 10px",
          borderRadius: 4,
          marginBottom: 16,
          lineHeight: 1.6,
        }}
      >
        セキュリティ警告 (POC): パスワードは固定値 <code style={codeStyle}>hackit</code>{" "}
        です。本番運用前に強化してください。
      </div>

      {rows.length === 0 ? (
        <div style={{ color: colors.textSecondary, fontSize: 14 }}>
          公開可能な action がありません。
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={tableStyle}>
            <thead>
              <tr style={{ background: colors.surface }}>
                <th style={thStyle}>Event</th>
                <th style={thStyle}>Action</th>
                <th style={thStyle}>閲覧 URL</th>
                <th style={thStyle}>編集 URL</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const meta = ACTION_META[row.action.actionType as EventActionType];
                return (
                  <tr
                    key={row.action.id}
                    style={{ borderTop: `1px solid ${colors.border}` }}
                  >
                    <td style={tdStyle}>{row.event.name}</td>
                    <td style={tdStyle}>
                      {meta?.icon ?? ""} {meta?.label ?? row.action.actionType}
                    </td>
                    <td style={tdStyle}>
                      <TokenCell
                        url={row.tokens?.viewUrl ?? null}
                        loading={row.loading}
                        onCopy={() =>
                          row.tokens?.viewUrl && copyToClipboard(row.tokens.viewUrl)
                        }
                        onGenerate={() => handleGenerate(row, "view")}
                        onDelete={() => handleDelete(row, "view")}
                      />
                    </td>
                    <td style={tdStyle}>
                      <TokenCell
                        url={row.tokens?.editUrl ?? null}
                        loading={row.loading}
                        onCopy={() =>
                          row.tokens?.editUrl && copyToClipboard(row.tokens.editUrl)
                        }
                        onGenerate={() => handleGenerate(row, "edit")}
                        onDelete={() => handleDelete(row, "edit")}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TokenCell({
  url,
  loading,
  onCopy,
  onGenerate,
  onDelete,
}: {
  url: string | null;
  loading: boolean;
  onCopy: () => void;
  onGenerate: () => void;
  onDelete: () => void;
}) {
  if (loading) {
    return <span style={{ color: colors.textMuted, fontSize: 12 }}>読み込み中</span>;
  }
  if (!url) {
    return (
      <button type="button" onClick={onGenerate} style={smallPrimaryButton}>
        + 発行
      </button>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <code
        style={{
          fontSize: 11,
          background: colors.surface,
          padding: "2px 6px",
          borderRadius: 4,
          wordBreak: "break-all",
          display: "block",
        }}
        title={url}
      >
        {url.length > 60 ? `${url.slice(0, 60)}...` : url}
      </code>
      <div style={{ display: "flex", gap: 4 }}>
        <button type="button" onClick={onCopy} style={smallButton}>
          コピー
        </button>
        <button
          type="button"
          onClick={onGenerate}
          style={smallButton}
          title="新しい URL を発行 (現在の URL は無効になります)"
        >
          再発行
        </button>
        <button type="button" onClick={onDelete} style={smallDangerButton}>
          削除
        </button>
      </div>
    </div>
  );
}

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 13,
};

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "8px 10px",
  fontSize: 12,
  color: colors.textSecondary,
  fontWeight: 500,
  borderBottom: `1px solid ${colors.border}`,
};

const tdStyle: React.CSSProperties = {
  padding: "10px",
  verticalAlign: "top",
};

const codeStyle: React.CSSProperties = {
  background: colors.surface,
  padding: "1px 4px",
  borderRadius: 3,
  fontSize: 12,
};

const smallButton: React.CSSProperties = {
  padding: "4px 8px",
  fontSize: 12,
  background: colors.background,
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: 4,
  cursor: "pointer",
  color: colors.text,
};

const smallDangerButton: React.CSSProperties = {
  ...smallButton,
  color: colors.danger,
  borderColor: colors.danger,
};

const smallPrimaryButton: React.CSSProperties = {
  padding: "6px 12px",
  fontSize: 12,
  background: colors.primary,
  color: colors.textInverse,
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
};
