import { useEffect, useState, type CSSProperties } from "react";
import type { EventAction, SlackRole } from "../../types";
import { api } from "../../api";
import { colors } from "../../styles/tokens";

// Sprint 24 / role_management:
// メインタブ。各ロールのサマリ (members 数 / channels 数) を一覧表示する。
// workspace 未設定なら警告を出して「設定」タブへ誘導する。
//
// 編集系の操作 (作成・編集・割当) は「ロール」タブに集約し、
// このタブは「現状俯瞰」だけに責務を絞る。

type Config = { workspaceId?: string };

function parseConfig(raw: string): Config {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

type Props = {
  eventId: string;
  action: EventAction;
};

export function RoleMainTab({ eventId, action }: Props) {
  const cfg = parseConfig(action.config);
  const workspaceId = cfg.workspaceId;
  const [roles, setRoles] = useState<SlackRole[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRoles(null);
    setError(null);
    api.roles
      .list(eventId, action.id)
      .then((list) => {
        if (cancelled) return;
        setRoles(Array.isArray(list) ? list : []);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "読み込みに失敗しました");
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, action.id]);

  return (
    <div>
      {!workspaceId && (
        <div style={s.warn}>
          ワークスペースが未設定です。「その他設定」タブから登録してください。
          未設定のままだとメンバー名簿取得・同期が動作しません。
        </div>
      )}

      <div style={s.headerRow}>
        <h3 style={{ margin: 0, fontSize: "1.05rem" }}>ロール一覧サマリ</h3>
      </div>

      {error && <div style={s.error}>エラー: {error}</div>}

      {roles === null ? (
        <div style={s.hint}>読み込み中...</div>
      ) : roles.length === 0 ? (
        <div style={s.empty}>
          ロールが未登録です。「ロール」タブから追加してください。
        </div>
      ) : (
        <div style={{ display: "grid", gap: "0.5rem" }}>
          {roles.map((r) => (
            <div key={r.id} style={s.row}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{r.name}</div>
                {r.description && (
                  <div style={s.meta}>{r.description}</div>
                )}
              </div>
              <div style={s.counts}>
                <span style={s.badge}>メンバー {r.membersCount}</span>
                <span style={s.badge}>チャンネル {r.channelsCount}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <p style={{ ...s.meta, marginTop: "1.5rem" }}>
        編集 / 追加 / 削除は「ロール」タブから操作してください。
        Slack 側に反映するには「同期」タブで sync を実行します。
      </p>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  headerRow: {
    display: "flex",
    alignItems: "center",
    marginBottom: "0.75rem",
  },
  warn: {
    padding: "0.75rem",
    marginBottom: "1rem",
    color: colors.warning,
    background: colors.warningSubtle,
    borderRadius: "0.25rem",
    fontSize: "0.875rem",
  },
  error: {
    padding: "0.75rem",
    marginBottom: "0.75rem",
    color: colors.danger,
    background: colors.dangerSubtle,
    borderRadius: "0.25rem",
    fontSize: "0.875rem",
  },
  hint: {
    padding: "1rem",
    color: colors.textSecondary,
    textAlign: "center",
    fontSize: "0.875rem",
  },
  empty: {
    padding: "1.5rem",
    textAlign: "center",
    color: colors.textSecondary,
    border: `1px dashed ${colors.borderStrong}`,
    borderRadius: "0.5rem",
    fontSize: "0.875rem",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    padding: "0.75rem 1rem",
    border: `1px solid ${colors.border}`,
    borderRadius: "0.375rem",
    background: colors.background,
    flexWrap: "wrap",
  },
  meta: {
    fontSize: "0.75rem",
    color: colors.textSecondary,
    marginTop: "0.125rem",
  },
  counts: {
    display: "flex",
    gap: "0.5rem",
    flexShrink: 0,
  },
  badge: {
    padding: "0.125rem 0.5rem",
    background: colors.primarySubtle,
    color: colors.primaryHover,
    borderRadius: "0.25rem",
    fontSize: "0.75rem",
    fontWeight: 500,
  },
};
