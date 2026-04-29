import { useEffect, useState } from "react";
import type { Workspace } from "../types";
import { api } from "../api";

// ADR-0006: Slack workspace 管理画面
// - 一覧 / 新規登録 / 削除 をサポート
// - bot_token / signing_secret は登録時のみ送信し、サーバーは AES-256-GCM で暗号化保存
export function WorkspacesPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.workspaces
      .list()
      .then((list) => {
        if (!cancelled) {
          setWorkspaces(list);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "読み込みに失敗");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const handleDelete = async (ws: Workspace) => {
    if (
      !confirm(
        `ワークスペース「${ws.name}」を削除しますか？\n紐付いたミーティングがある場合は削除できません。`,
      )
    ) {
      return;
    }
    try {
      await api.workspaces.delete(ws.id);
      setRefreshKey((k) => k + 1);
    } catch (e) {
      alert(e instanceof Error ? e.message : "削除に失敗しました");
    }
  };

  if (loading) return <div style={{ padding: "1rem" }}>読み込み中...</div>;
  if (error)
    return (
      <div style={{ padding: "1rem", color: "#dc2626" }}>エラー: {error}</div>
    );

  return (
    <div style={{ padding: "1rem" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          marginBottom: "1rem",
        }}
      >
        <h2 style={{ margin: 0 }}>
          ワークスペース管理 ({workspaces.length}件)
        </h2>
        <button
          onClick={() => setShowForm(true)}
          style={{ marginLeft: "auto" }}
        >
          + 新規追加
        </button>
      </div>

      {workspaces.length === 0 && (
        <div style={{ color: "#6b7280" }}>
          ワークスペースが登録されていません。
        </div>
      )}

      {workspaces.map((ws) => (
        <div
          key={ws.id}
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: "0.375rem",
            padding: "0.75rem",
            marginBottom: "0.5rem",
            display: "flex",
            alignItems: "center",
          }}
        >
          <div style={{ flex: 1 }}>
            <strong>{ws.name}</strong>
            <div style={{ fontSize: "0.75rem", color: "#6b7280" }}>
              team_id: {ws.slackTeamId} / 登録日: {ws.createdAt.slice(0, 10)}
            </div>
          </div>
          <button
            onClick={() => handleDelete(ws)}
            style={{ background: "#dc2626", color: "white" }}
            disabled={ws.id === "ws_default"}
            title={
              ws.id === "ws_default"
                ? "default workspace は削除できません"
                : ""
            }
          >
            削除
          </button>
        </div>
      ))}

      {showForm && (
        <WorkspaceCreateForm
          onClose={() => setShowForm(false)}
          onCreated={() => {
            setShowForm(false);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}

function WorkspaceCreateForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [botToken, setBotToken] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!botToken.trim() || !signingSecret.trim()) {
      setError("Bot Token と Signing Secret は必須です");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.workspaces.create({
        name: name.trim() || undefined,
        botToken: botToken.trim(),
        signingSecret: signingSecret.trim(),
      });
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "登録に失敗しました");
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "white",
          padding: "1.5rem",
          borderRadius: "0.5rem",
          width: "min(500px, 90vw)",
          maxHeight: "90vh",
          overflow: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0 }}>ワークスペース登録</h3>

        {error && (
          <div style={{ color: "#dc2626", marginBottom: "0.5rem" }}>
            {error}
          </div>
        )}

        <div style={{ marginBottom: "0.75rem" }}>
          <label>表示名（任意、空ならSlackから取得）</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={submitting}
            style={{ width: "100%" }}
          />
        </div>
        <div style={{ marginBottom: "0.75rem" }}>
          <label>Bot Token (xoxb-...) *</label>
          <input
            type="password"
            autoComplete="new-password"
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            disabled={submitting}
            style={{ width: "100%" }}
            placeholder="xoxb-..."
          />
        </div>
        <div style={{ marginBottom: "0.75rem" }}>
          <label>Signing Secret *</label>
          <input
            type="password"
            autoComplete="new-password"
            value={signingSecret}
            onChange={(e) => setSigningSecret(e.target.value)}
            disabled={submitting}
            style={{ width: "100%" }}
          />
        </div>
        <div
          style={{
            fontSize: "0.75rem",
            color: "#6b7280",
            marginBottom: "1rem",
          }}
        >
          Bot Token と Signing Secret は AES-256-GCM で暗号化して保存されます。
          team_id は登録時に Slack auth.test で自動取得されます。
        </div>

        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            justifyContent: "flex-end",
          }}
        >
          <button onClick={onClose} disabled={submitting}>
            キャンセル
          </button>
          <button
            onClick={handleSubmit}
            disabled={
              submitting || !botToken.trim() || !signingSecret.trim()
            }
            style={{ background: "#2563eb", color: "white" }}
          >
            {submitting ? "登録中..." : "登録"}
          </button>
        </div>
      </div>
    </div>
  );
}
