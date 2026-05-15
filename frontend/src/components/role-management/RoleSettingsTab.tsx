import { useEffect, useState, type CSSProperties } from "react";
import type { EventAction, Workspace } from "../../types";
import { api } from "../../api";
import { useToast } from "../ui/Toast";
import { colors } from "../../styles/tokens";

// Sprint 24 / role_management:
// 設定タブ。event_actions.config = { workspaceId: string } を編集する。
// workspace を未設定 / 不正な状態だと workspace-members 取得 / 同期 API が
// 全部失敗するので、最初に必ず登録してもらう必要がある。
//
// 「無効化」「削除」のボタンは ActionDetailPage の generic settings 領域で
// 自動描画されるので、このコンポーネントは workspace 編集 UI のみに責務を絞る。

type Config = { workspaceId?: string; autoInviteEnabled?: boolean };

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
  onSaved: () => void;
};

export function RoleSettingsTab({ eventId, action, onSaved }: Props) {
  const toast = useToast();
  const initial = parseConfig(action.config);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string>(
    initial.workspaceId ?? "",
  );
  const [autoInviteEnabled, setAutoInviteEnabled] = useState<boolean>(
    initial.autoInviteEnabled === true,
  );
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.workspaces
      .list()
      .then((list) => {
        if (cancelled) return;
        const safe = Array.isArray(list) ? list : [];
        setWorkspaces(safe);
        // 既存 config に workspaceId 未設定で workspace が 1 つ以上あれば
        // 先頭で初期化 (空セレクトを避ける)。保存ボタンで確定。
        setWorkspaceId((cur) => cur || safe[0]?.id || "");
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setWorkspaces([]);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSave = async () => {
    if (!workspaceId) {
      toast.error("ワークスペースを選択してください");
      return;
    }
    setSubmitting(true);
    try {
      const config: Config = { workspaceId, autoInviteEnabled };
      await api.events.actions.update(eventId, action.id, {
        config: JSON.stringify(config),
      });
      toast.success("設定を保存しました");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div style={{ padding: "1rem" }}>読み込み中...</div>;
  }

  return (
    <div>
      <p style={s.desc}>
        ロール管理は workspace 単位で動作します。最初にワークスペースを
        指定してください。同じ event でも別 workspace の roles を独立して
        運用したい場合は、role_management アクションを workspace ごとに作成します
        （現在は 1 event = 1 アクションの制約があるため、複数 workspace 運用は
        将来対応）。
      </p>

      <div style={{ marginBottom: "1rem" }}>
        <label style={s.label}>ワークスペース</label>
        {workspaces.length === 0 ? (
          <div style={s.warn}>
            ワークスペースが未登録です。先に「ワークスペース管理」から登録してください。
          </div>
        ) : (
          <select
            value={workspaceId}
            onChange={(e) => setWorkspaceId(e.target.value)}
            style={s.select}
            disabled={submitting}
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        )}
      </div>

      <div style={{ marginBottom: "1rem" }}>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={autoInviteEnabled}
            onChange={(e) => setAutoInviteEnabled(e.target.checked)}
            disabled={submitting || workspaces.length === 0}
          />
          <span style={{ fontSize: "0.875rem", color: colors.text }}>
            毎朝 9:00 JST に invite を自動実行
          </span>
        </label>
        <p
          style={{
            fontSize: "0.75rem",
            color: colors.textSecondary,
            margin: "0.25rem 0 0 1.5rem",
          }}
        >
          kick は手動のみ。invite だけ自動で channel に追加します。
        </p>
      </div>

      <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}>
        <button
          onClick={handleSave}
          disabled={submitting || workspaces.length === 0}
          style={s.primaryBtn}
        >
          {submitting ? "保存中..." : "保存"}
        </button>
      </div>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  desc: {
    color: colors.textSecondary,
    fontSize: "0.875rem",
    marginTop: 0,
  },
  label: {
    display: "block",
    marginBottom: "0.25rem",
    fontSize: "0.875rem",
    color: colors.text,
  },
  select: {
    width: "100%",
    padding: "0.5rem",
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: "0.25rem",
    boxSizing: "border-box",
  },
  warn: {
    padding: "0.75rem",
    color: colors.warning,
    background: colors.warningSubtle,
    borderRadius: "0.25rem",
    fontSize: "0.875rem",
  },
  primaryBtn: {
    background: colors.primary,
    color: colors.textInverse,
    border: "none",
    padding: "0.5rem 1rem",
    borderRadius: "0.25rem",
    cursor: "pointer",
  },
};
