import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { useParams } from "react-router-dom";
import { useToast } from "../components/ui/Toast";
import { useIsMobile } from "../hooks/useIsMobile";
import { colors } from "../styles/tokens";

// 宗教イベント PR5: whitelist メンバー向け非公開フォーム。
// /whitelist/:token で本人だけが開き、「一緒に開発したい / 誘いたい人」の
// フルネームを非公開で登録する。
//
// 仕様:
//   - magic-link token (whitelist_members.token) で本人を識別する。
//   - 登録内容は本人だけが閲覧・編集でき、運営・他メンバーには公開されない
//     (BE 側で保存時暗号化)。
//   - admin token は **送らない**。`request<T>()` ヘルパは x-admin-token を
//     自動注入するため、ここでは fetch を直接叩く (公開エンドポイント)。
//   - UI に ID は一切出さない (本人は displayName で挨拶する)。
//
// API (BE / src/routes/api/whitelist-public.ts):
//   GET  /api/whitelist/:token  -> { displayName: string, names: string[] }
//                                  (token 不一致は 404)
//   POST /api/whitelist/:token  body: { names: string[] } -> { ok, count }

type FormMeta = {
  displayName: string;
  names: string[];
};

export function WhitelistFormPage() {
  const { token } = useParams<{ token: string }>();
  const toast = useToast();
  const isMobile = useIsMobile();

  const [meta, setMeta] = useState<FormMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // 名前リストの行 (空行も許容し、送信時に trim + 空行除去する)。
  const [names, setNames] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      setFetchError("リンクが無効です");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setFetchError(null);
    fetch(`/api/whitelist/${encodeURIComponent(token)}`)
      .then(async (res) => {
        if (!res.ok) {
          if (res.status === 404) {
            throw new Error(
              "リンクが無効または失効しています。担当者から最新のリンクを共有してもらってください。",
            );
          }
          throw new Error(`読み込みに失敗しました (HTTP ${res.status})`);
        }
        return (await res.json()) as FormMeta;
      })
      .then((data) => {
        if (cancelled) return;
        setMeta(data);
        setNames(data.names);
      })
      .catch((e) => {
        if (cancelled) return;
        setFetchError(
          e instanceof Error ? e.message : "読み込みに失敗しました",
        );
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const updateName = (index: number, value: string) => {
    setSaved(false);
    setNames((prev) => prev.map((n, i) => (i === index ? value : n)));
  };

  const addRow = () => {
    setSaved(false);
    setNames((prev) => [...prev, ""]);
  };

  const removeRow = (index: number) => {
    setSaved(false);
    setNames((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    // trim + 空行除去してから送信する (BE も同様に正規化するが UX のため先に整える)。
    const cleaned = names.map((n) => n.trim()).filter((n) => n.length > 0);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/whitelist/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names: cleaned }),
      });
      if (!res.ok) {
        let detail = "";
        try {
          detail = await res.text();
        } catch {
          // noop
        }
        throw new Error(
          `保存に失敗しました (HTTP ${res.status}) ${detail.slice(0, 120)}`.trim(),
        );
      }
      // 送信後はサーバ正規化済みの値で state を揃え、空行を残さない。
      setNames(cleaned);
      setSaved(true);
      toast.success("保存しました");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存に失敗しました");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <Layout>
        <div style={{ color: colors.textSecondary }}>読み込み中...</div>
      </Layout>
    );
  }

  if (fetchError || !meta) {
    return (
      <Layout>
        <div role="alert" style={errorBoxStyle}>
          {fetchError ?? "リンクが無効です"}
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div style={{ marginBottom: "1.5rem" }}>
        <div style={eyebrowStyle}>非公開リスト</div>
        <h1
          style={{
            margin: "0.25rem 0 0",
            fontSize: isMobile ? "1.25rem" : "1.5rem",
          }}
        >
          {meta.displayName} さんのリスト
        </h1>
        <p
          style={{
            color: colors.textSecondary,
            fontSize: "0.875rem",
            marginTop: "0.5rem",
            lineHeight: 1.6,
          }}
        >
          一緒に開発したい・誘いたい人のフルネームを登録してください。
        </p>
      </div>

      {/* プライバシー安心カード: 本人だけが閲覧・編集できることを明示する。 */}
      <div style={privacyCardStyle}>
        <strong style={{ display: "block", marginBottom: "0.25rem" }}>
          このリストはあなただけのものです
        </strong>
        このリストはあなただけが閲覧・編集できます。運営や他のメンバーには公開されません。
      </div>

      <form onSubmit={handleSubmit}>
        <div style={fieldLabelStyle}>会いたい人・誘いたい人のフルネーム</div>

        {names.length === 0 ? (
          <div style={emptyStateStyle}>
            まだ登録されていません。「+ 名前を追加」から登録を始めましょう。
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {names.map((name, i) => (
              // 並び替えはないので index ベースの key で十分 (このリポジトリは eslint 未設定)。
              <div key={i} style={{ display: "flex", gap: "0.5rem" }}>
                <input
                  type="text"
                  value={name}
                  onChange={(ev) => updateName(i, ev.target.value)}
                  maxLength={100}
                  placeholder="山田 太郎"
                  aria-label={`名前 ${i + 1}`}
                  style={{ ...inputStyle, flex: 1 }}
                />
                <button
                  type="button"
                  onClick={() => removeRow(i)}
                  aria-label={`名前 ${i + 1} を削除`}
                  style={removeBtnStyle}
                >
                  削除
                </button>
              </div>
            ))}
          </div>
        )}

        <button type="button" onClick={addRow} style={addBtnStyle}>
          + 名前を追加
        </button>

        <div style={actionsStyle}>
          <span style={{ fontSize: "0.875rem", color: colors.textSecondary }}>
            {names.filter((n) => n.trim().length > 0).length} 人登録中
          </span>
          <button
            type="submit"
            disabled={submitting}
            style={{
              ...submitBtnStyle,
              width: isMobile ? "100%" : undefined,
              background: submitting ? colors.primarySubtle : colors.primary,
              cursor: submitting ? "not-allowed" : "pointer",
            }}
          >
            {submitting ? "保存中..." : "保存する"}
          </button>
        </div>

        {saved && (
          <div style={successBoxStyle}>
            保存しました。同じ URL を使って、いつでも内容を編集できます。
          </div>
        )}
      </form>
    </Layout>
  );
}

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        maxWidth: 720,
        margin: "0 auto",
        padding: "2rem 1rem",
        fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
        color: colors.text,
      }}
    >
      {children}
    </div>
  );
}

const eyebrowStyle: CSSProperties = {
  fontSize: "0.75rem",
  color: colors.textSecondary,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
};

const fieldLabelStyle: CSSProperties = {
  display: "block",
  fontSize: "0.875rem",
  fontWeight: 600,
  color: colors.text,
  marginBottom: "0.5rem",
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "0.5rem 0.625rem",
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: "0.375rem",
  fontSize: "0.95rem",
  fontFamily: "inherit",
  boxSizing: "border-box",
  background: colors.background,
  color: colors.text,
};

const removeBtnStyle: CSSProperties = {
  flexShrink: 0,
  padding: "0 0.875rem",
  minHeight: 44,
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: "0.375rem",
  background: colors.background,
  color: colors.danger,
  fontSize: "0.875rem",
  cursor: "pointer",
};

const addBtnStyle: CSSProperties = {
  marginTop: "0.75rem",
  padding: "0.5rem 0.875rem",
  minHeight: 44,
  border: `1px dashed ${colors.borderStrong}`,
  borderRadius: "0.375rem",
  background: colors.surface,
  color: colors.primary,
  fontSize: "0.875rem",
  fontWeight: 600,
  cursor: "pointer",
};

const actionsStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.75rem",
  marginTop: "1.25rem",
  paddingTop: "0.75rem",
  borderTop: `1px solid ${colors.border}`,
  flexWrap: "wrap",
};

const submitBtnStyle: CSSProperties = {
  padding: "0.625rem 1.5rem",
  minHeight: 44,
  border: "none",
  borderRadius: "0.375rem",
  color: colors.textInverse,
  fontSize: "1rem",
  fontWeight: "bold",
};

const privacyCardStyle: CSSProperties = {
  padding: "0.875rem 1rem",
  background: colors.primarySubtle,
  border: `1px solid ${colors.primary}`,
  borderRadius: "0.5rem",
  fontSize: "0.875rem",
  lineHeight: 1.6,
  color: colors.text,
  marginBottom: "1.5rem",
};

const emptyStateStyle: CSSProperties = {
  padding: "1.25rem",
  background: colors.surface,
  border: `1px dashed ${colors.borderStrong}`,
  borderRadius: "0.5rem",
  textAlign: "center",
  fontSize: "0.875rem",
  color: colors.textSecondary,
};

const errorBoxStyle: CSSProperties = {
  padding: "1.25rem 1.5rem",
  background: colors.dangerSubtle,
  color: colors.danger,
  borderRadius: "0.5rem",
  textAlign: "center",
  fontSize: "0.9rem",
  lineHeight: 1.6,
};

const successBoxStyle: CSSProperties = {
  marginTop: "1rem",
  padding: "0.75rem 1rem",
  background: colors.successSubtle,
  color: colors.text,
  border: `1px solid ${colors.success}`,
  borderRadius: "0.5rem",
  fontSize: "0.875rem",
  lineHeight: 1.5,
};
