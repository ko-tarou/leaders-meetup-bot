import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { request } from "../../api/client";
import { colors } from "../../styles/tokens";

// 宗教イベント PR6: whitelist アクションの admin 管理タブ。
// メンバー同期 / 提出状況の確認 / 本人専用リンクの DM 配布・再発行 / 全会一致結果の
// 2 セクションを並べる。
//
// プライバシー方針 (backend と同じ):
//   - members API は「ステータスのみ」を返し、各メンバーが登録した名前は露出しない。
//     ここでも一切表示しない。
//   - token (本人専用フォームの鍵) は API レスポンスにも含まれず、画面にも出さない。
//     リンクは管理者に見せず Bot DM で本人にのみ届ける (全員のフォームに入れる
//     穴を塞ぐ)。

type Member = {
  id: string;
  displayName: string;
  submitted: boolean;
  submittedAt: string | null;
};
type SendResult = { sent: number; failed: number; total: number };
type Result = { nameNormalized: string; notifiedAt: string };

function Section({ title, empty, isEmpty, children }: {
  title: string; empty: string; isEmpty: boolean; children: ReactNode;
}) {
  return (
    <section>
      <h3 style={s.h}>{title}</h3>
      {isEmpty ? <div style={s.empty}>{empty}</div> : <div style={s.list}>{children}</div>}
    </section>
  );
}

/** ISO 文字列を "YYYY-MM-DD HH:mm" に整形する (列幅を抑えるため秒以下は捨てる)。 */
function fmt(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

export function WhitelistAdminTab({ eventId, actionId }: { eventId: string; actionId: string }) {
  const base = `/orgs/${eventId}/actions/${actionId}/whitelist`;
  const [members, setMembers] = useState<Member[] | null>(null);
  const [results, setResults] = useState<Result[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [m, r] = await Promise.all([
        request<Member[]>(`${base}/members`),
        request<Result[]>(`${base}/results`),
      ]);
      setMembers(m); setResults(r);
    } catch (err) { setError(err instanceof Error ? err.message : "load failed"); }
  }, [base]);
  useEffect(() => { void load(); }, [load]);

  async function sync() {
    setBusy("sync"); setError(null); setNotice(null);
    try {
      await request(`${base}/members/sync`, { method: "POST" });
      await load();
      setNotice("ロールのメンバーを同期しました。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "sync failed");
    } finally { setBusy(null); }
  }

  async function rotate(m: Member) {
    if (!confirm(`${m.displayName} の提出リンクを再発行します。旧リンクは無効になります。よろしいですか？`)) return;
    setBusy(`rot-${m.id}`); setError(null); setNotice(null);
    try {
      await request(`${base}/members/${m.id}/rotate-token`, { method: "POST" });
      await load();
      setNotice(`${m.displayName} のリンクを再発行しました。新しいリンクは「DMで送信」で届けてください。`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "rotate failed");
    } finally { setBusy(null); }
  }

  async function distribute() {
    setBusy("distribute"); setError(null); setNotice(null);
    try {
      const r = await request<SendResult>(`${base}/distribute`, { method: "POST" });
      setNotice(`${r.sent}人にDMで配布しました（失敗 ${r.failed}件）。`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "distribute failed");
    } finally { setBusy(null); }
  }

  async function send(m: Member) {
    setBusy(`send-${m.id}`); setError(null); setNotice(null);
    try {
      const r = await request<SendResult>(`${base}/members/${m.id}/send`, { method: "POST" });
      setNotice(
        r.sent > 0
          ? `${m.displayName} にDMで送信しました。`
          : `${m.displayName} へのDM送信に失敗しました。`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "send failed");
    } finally { setBusy(null); }
  }

  if (members === null || results === null) {
    return <div style={s.hint}>読み込み中...</div>;
  }

  return (
    <div style={{ display: "grid", gap: "1.5rem" }}>
      {error && <div style={s.error}>エラー: {error}</div>}
      {notice && <div style={s.notice}>{notice}</div>}

      <Section
        title={`👥 メンバー (${members.length})`}
        empty="メンバー未登録です。「メンバー同期」で対象ロールのメンバーを取り込んでください。"
        isEmpty={members.length === 0}
      >
        {members.map((m) => (
          <div key={m.id} style={s.row}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{m.displayName}</div>
              <div style={s.meta}>
                {m.submitted
                  ? `✅ 提出済${m.submittedAt ? ` (${fmt(m.submittedAt)})` : ""}`
                  : "⚪ 未提出"}
              </div>
            </div>
            <button className="btn btn-ghost btn-sm" disabled={busy === `send-${m.id}`}
              aria-label={`${m.displayName} にDMで送信`}
              onClick={() => void send(m)}>
              {busy === `send-${m.id}` ? "送信中..." : "DMで送信"}
            </button>
            <button className="btn btn-ghost btn-sm" disabled={busy === `rot-${m.id}`}
              aria-label={`${m.displayName} の提出リンクを再発行`}
              onClick={() => void rotate(m)}>
              リンク再発行
            </button>
          </div>
        ))}
      </Section>
      <p style={s.helper}>
        「メンバー同期」は設定で指定したロールのメンバーを取り込み、各自の提出リンクを発行します。
        「全員に配布」で、各メンバーに本人専用リンクを Bot DM で送ります（リンクは管理者には表示されません）。
      </p>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <button className="btn btn-primary btn-sm" disabled={busy === "sync"} onClick={() => void sync()}>
          {busy === "sync" ? "同期中..." : "メンバー同期"}
        </button>
        <button className="btn btn-primary btn-sm" disabled={busy === "distribute" || members.length === 0}
          onClick={() => void distribute()}>
          {busy === "distribute" ? "配布中..." : "全員に配布"}
        </button>
      </div>

      <Section
        title={`🎯 全会一致結果 (${results.length})`}
        empty="まだ全会一致はありません"
        isEmpty={results.length === 0}
      >
        {results.map((r) => (
          <div key={`${r.nameNormalized}-${r.notifiedAt}`} style={s.row}>
            <span style={{ flex: 1 }}>{r.nameNormalized}</span>
            <span style={s.meta}>{fmt(r.notifiedAt)}</span>
          </div>
        ))}
      </Section>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  h: { margin: "0 0 0.5rem", fontSize: "1rem" },
  list: { display: "grid", gap: "0.5rem" },
  row: { display: "flex", alignItems: "center", gap: "0.5rem",
    padding: "0.5rem 0.75rem", border: `1px solid ${colors.border}`,
    borderRadius: "0.375rem", background: colors.background, fontSize: "0.875rem" },
  meta: { fontSize: "0.75rem", color: colors.textSecondary },
  empty: { padding: "0.75rem", textAlign: "center", color: colors.textSecondary,
    border: `1px dashed ${colors.borderStrong}`, borderRadius: "0.375rem",
    fontSize: "0.875rem" },
  hint: { padding: "1rem", color: colors.textSecondary, textAlign: "center" },
  helper: { margin: 0, fontSize: "0.75rem", color: colors.textSecondary },
  error: { padding: "0.75rem", color: colors.danger, background: colors.dangerSubtle,
    borderRadius: "0.25rem", fontSize: "0.875rem" },
  notice: { padding: "0.75rem", color: colors.primaryHover, background: colors.primarySubtle,
    borderRadius: "0.25rem", fontSize: "0.875rem" },
};
