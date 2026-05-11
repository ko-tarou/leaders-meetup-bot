import { useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { setAdminToken } from "../api";
import { setPublicGranted, setPublicMode } from "../hooks/usePublicMode";
import { colors } from "../styles/tokens";

// 公開管理 (public-management): /public/:token のパスワード入力ページ。
// 成功時に admin token を localStorage に保存し、該当 action のページに redirect する。
//
// セキュリティ警告 (POC):
//   - パスワード 'hackit' は固定値。BE 側で hardcode されている。
//   - 認証成功で BE が ADMIN_TOKEN を直接返却する。
//   - 本番運用前に強化が必要 (token-bound 認可、有効期限、Rate limit 等)。

type AuthSuccess = {
  eventId: string;
  actionId: string;
  permission: "view" | "edit";
  adminToken: string;
};

export function PublicEntryPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();

  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/public-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      if (!res.ok) {
        setError(
          res.status === 401
            ? "パスワードまたは URL が間違っています"
            : `サーバーエラー (${res.status})`,
        );
        return;
      }
      const data = (await res.json()) as AuthSuccess;
      // admin token / public mode を保存
      setAdminToken(data.adminToken);
      setPublicMode(data.permission);

      // 対応する action 詳細ページに遷移するため、actionType を解決する必要がある。
      // ここでは admin token がある状態で /api/orgs/:eventId/actions を叩いて actionType を特定。
      try {
        const actionsRes = await fetch(
          `/api/orgs/${data.eventId}/actions`,
          {
            headers: { "x-admin-token": data.adminToken },
          },
        );
        if (actionsRes.ok) {
          const actions = (await actionsRes.json()) as Array<{
            id: string;
            actionType: string;
          }>;
          const matched = actions.find((a) => a.id === data.actionId);
          if (matched) {
            // 公開モードで許可された action を localStorage に保存し、
            // App.tsx の route ガードで他 action / event への遷移を防ぐ。
            setPublicGranted({
              eventId: data.eventId,
              actionType: matched.actionType,
            });
            navigate(
              `/events/${data.eventId}/actions/${matched.actionType}`,
              { replace: true },
            );
            return;
          }
        }
      } catch {
        // noop, fallback below
      }
      // fallback: event トップへ
      navigate(`/events/${data.eventId}`, { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "ネットワークエラー");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: colors.surface,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          background: colors.background,
          padding: 32,
          borderRadius: 8,
          boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
          width: "100%",
          maxWidth: 400,
        }}
      >
        <h1 style={{ margin: 0, marginBottom: 16, fontSize: 20, color: colors.text }}>
          DevHub Ops 公開ページ
        </h1>
        <p
          style={{
            margin: 0,
            marginBottom: 20,
            fontSize: 13,
            color: colors.textSecondary,
            lineHeight: 1.6,
          }}
        >
          パスワードを入力してください。アクセス権限 (閲覧 / 編集) は
          URL ごとに事前設定されています。
        </p>
        <label
          style={{
            display: "block",
            fontSize: 13,
            color: colors.text,
            marginBottom: 6,
          }}
        >
          パスワード
        </label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          autoComplete="current-password"
          style={{
            width: "100%",
            padding: "8px 10px",
            fontSize: 14,
            border: `1px solid ${colors.borderStrong}`,
            borderRadius: 4,
            boxSizing: "border-box",
            marginBottom: 12,
          }}
        />
        {error && (
          <div
            style={{
              color: colors.danger,
              fontSize: 13,
              marginBottom: 12,
              padding: "8px 10px",
              background: colors.dangerSubtle,
              borderRadius: 4,
            }}
          >
            {error}
          </div>
        )}
        <button
          type="submit"
          disabled={loading || !password}
          style={{
            width: "100%",
            padding: "10px 16px",
            fontSize: 14,
            background: colors.primary,
            color: colors.textInverse,
            border: "none",
            borderRadius: 4,
            cursor: loading || !password ? "not-allowed" : "pointer",
            opacity: loading || !password ? 0.6 : 1,
          }}
        >
          {loading ? "認証中..." : "ログイン"}
        </button>
      </form>
    </div>
  );
}
