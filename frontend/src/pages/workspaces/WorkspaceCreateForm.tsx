// Phase4-7 純抽出: WorkspacesPage から WorkspaceCreateForm を移設。
// 振る舞い・state・バリデーション・副作用は一字一句不変 (純粋抽出)。
// 手動登録は OAuth が使えない場合の fallback (ADR-0007)。
import { useState } from "react";
import { api } from "../../api";
import { useIsMobile } from "../../hooks/useIsMobile";
import { colors } from "../../styles/tokens";

export function WorkspaceCreateForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const isMobile = useIsMobile();
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
        // mobile では上端から表示 (キーボード出現時の見切れ防止)
        alignItems: isMobile ? "stretch" : "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      {/* HitoLink DS: anim-pop-in でモーダルを spring 着地させる。 */}
      <div
        className="anim-pop-in"
        style={{
          background: "white",
          padding: isMobile ? "1rem" : "1.5rem",
          borderRadius: isMobile ? 0 : "0.5rem",
          width: isMobile ? "100%" : "min(500px, 90vw)",
          maxHeight: isMobile ? "100vh" : "90vh",
          overflow: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0 }}>ワークスペース手動登録</h3>
        <p style={{ fontSize: "0.8rem", color: colors.textSecondary, marginTop: 0 }}>
          通常は OAuth フロー（「Slack でインストール」ボタン）を使用してください。
          既存 App の Bot Token / Signing Secret を直接登録する場合のみこちらを利用します。
        </p>

        {error && (
          <div style={{ color: colors.danger, marginBottom: "0.5rem" }}>
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
            color: colors.textSecondary,
            marginBottom: "1rem",
          }}
        >
          Bot Token と Signing Secret は AES-256-GCM で暗号化して保存されます。
          team_id は登録時に Slack auth.test で自動取得されます。
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: isMobile ? "column" : "row",
            gap: "0.5rem",
            justifyContent: "flex-end",
          }}
        >
          {/* HitoLink DS: cancel = ghost、register = primary。 */}
          <button
            onClick={onClose}
            disabled={submitting}
            className="btn btn-ghost btn-sm"
            style={{
              width: isMobile ? "100%" : undefined,
              minHeight: 40,
              padding: "0.5rem 1rem",
            }}
          >
            キャンセル
          </button>
          <button
            onClick={handleSubmit}
            disabled={
              submitting || !botToken.trim() || !signingSecret.trim()
            }
            className="btn btn-primary btn-sm"
            style={{
              background: colors.primary,
              color: colors.textInverse,
              width: isMobile ? "100%" : undefined,
              minHeight: 40,
              padding: "0.5rem 1rem",
            }}
          >
            {submitting ? "登録中..." : "登録"}
          </button>
        </div>
      </div>
    </div>
  );
}
