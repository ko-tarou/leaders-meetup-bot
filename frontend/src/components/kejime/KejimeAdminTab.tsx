import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { request } from "../../api/client";
import { colors } from "../../styles/tokens";

// 003 朝勉強会けじめ制度 PR6: kejime_tracker 配下の admin タブ。
// 4 セクション (激辛ランキング / メンバー状況 / 申請待ち / 履歴) を flat に並べる。

type Member = { id: string; displayName: string; slackUserId: string;
  currentPoints: number; ramenCount: number; displayPoints: number };
type EventRow = { id: string; type: string; pointsDelta: number; ramenDelta: number;
  ref: string | null; note: string | null; decidedBy: string | null; occurredAt: string };
type Article = { id: string; memberId: string; memberDisplayName: string;
  qiitaUrl: string; bodyLength: number | null; status: string; createdAt: string };

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

// PR15: admin がメンバーの current_points を直接編集する行コンポーネント。
// 「編集」→ インライン input → 「保存」/ 「キャンセル」。0〜100 の整数のみ許可。
function MemberRow({ m, busy, onEdit }: {
  m: Member; busy: boolean; onEdit: (n: number) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(m.currentPoints));
  const parsed = Number(value);
  const invalid = value.trim() === ""
    || !Number.isInteger(parsed) || parsed < 0 || parsed > 100;

  if (!editing) {
    return (
      <div style={s.row}>
        <span style={{ flex: 1 }}>{m.displayName}</span>
        <span style={s.meta}>{m.currentPoints} / {m.displayPoints} / {m.ramenCount}</span>
        <button className="btn btn-ghost btn-sm" disabled={busy}
          aria-label={`${m.displayName} のポイントを編集`}
          onClick={() => { setValue(String(m.currentPoints)); setEditing(true); }}>
          編集
        </button>
      </div>
    );
  }
  return (
    <div style={s.row}>
      <span style={{ flex: 1 }}>{m.displayName}</span>
      <input
        type="number" min={0} max={100} step={1} value={value}
        aria-label={`${m.displayName} の新しいポイント`}
        aria-invalid={invalid} disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        style={{ width: "5rem", padding: "0.25rem", border: `1px solid ${colors.border}`,
          borderRadius: "0.25rem", fontSize: "0.875rem" }}
      />
      <button className="btn btn-primary btn-sm" disabled={busy || invalid}
        onClick={async () => { await onEdit(parsed); setEditing(false); }}>
        保存
      </button>
      <button className="btn btn-ghost btn-sm" disabled={busy}
        onClick={() => setEditing(false)}>
        キャンセル
      </button>
    </div>
  );
}

export function KejimeAdminTab({ eventId, actionId }: { eventId: string; actionId: string }) {
  const base = `/orgs/${eventId}/actions/${actionId}/kejime`;
  const [members, setMembers] = useState<Member[] | null>(null);
  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [articles, setArticles] = useState<Article[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [m, e, a] = await Promise.all([
        request<Member[]>(`${base}/members`),
        request<EventRow[]>(`${base}/events`),
        request<Article[]>(`${base}/articles?status=needs_review`),
      ]);
      setMembers(m); setEvents(e.slice(0, 20)); setArticles(a);
    } catch (err) { setError(err instanceof Error ? err.message : "load failed"); }
  }, [base]);
  useEffect(() => { void load(); }, [load]);

  async function post(path: string, body: object, key: string, msg: string) {
    if (!confirm(msg)) return;
    setBusy(key);
    try {
      await request(`${base}${path}`, { method: "POST", body: JSON.stringify(body) });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "operation failed");
    } finally { setBusy(null); }
  }

  async function syncSlack() {
    setBusy("sync-slack");
    setNotice(null);
    try {
      await request(`${base}/sync-slack`, { method: "POST", body: JSON.stringify({}) });
      setNotice("Slackメッセージを更新しました");
    } catch (err) {
      setError(err instanceof Error ? err.message : "sync failed");
    } finally { setBusy(null); }
  }

  if (members === null || events === null || articles === null) {
    return <div style={s.hint}>読み込み中...</div>;
  }
  const ranking = members.filter((m) => m.ramenCount > 0)
    .sort((a, b) => b.ramenCount - a.ramenCount);

  return (
    <div style={{ display: "grid", gap: "1.5rem" }}>
      {error && <div style={s.error}>エラー: {error}</div>}
      {notice && <div style={s.notice}>{notice}</div>}

      <Section title="🌶 激辛ランキング" empty="該当者なし" isEmpty={ranking.length === 0}>
        {ranking.map((m) => (
          <div key={m.id} style={s.row}>
            <div style={{ flex: 1 }}>{m.displayName} 🌶 ×{m.ramenCount}</div>
            <button className="btn btn-ghost btn-sm" disabled={busy === `r-${m.id}`}
              onClick={() => post("/ramen-reset", { memberId: m.id }, `r-${m.id}`,
                `${m.displayName} の激辛カウントを 0 にリセットします。よろしいですか？`)}>
              リセット
            </button>
          </div>
        ))}
      </Section>

      <Section title="📊 メンバー状況 (内部pt / 表示pt / 🌶)"
        empty="メンバー未登録" isEmpty={members.length === 0}>
        {members.map((m) => (
          <MemberRow
            key={m.id} m={m} busy={busy === `p-${m.id}`}
            onEdit={async (newPoints) => {
              const ok = confirm(
                `${m.displayName} のポイントを ${m.currentPoints}pt → ${newPoints}pt に変更します。よろしいですか？`,
              );
              if (!ok) return;
              setBusy(`p-${m.id}`);
              try {
                await request(`${base}/edit-points`, {
                  method: "POST",
                  body: JSON.stringify({ memberId: m.id, newPoints }),
                });
                await load();
              } catch (err) {
                setError(err instanceof Error ? err.message : "edit failed");
              } finally { setBusy(null); }
            }}
          />
        ))}
      </Section>

      <Section title={`📝 申請待ち記事 (${articles.length})`}
        empty="申請待ちなし" isEmpty={articles.length === 0}>
        {articles.map((a) => (
          <div key={a.id} style={s.row}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{a.memberDisplayName}</div>
              <div style={s.meta}>
                <a href={a.qiitaUrl} target="_blank" rel="noreferrer">{a.qiitaUrl}</a>
              </div>
              <div style={s.meta}>
                {a.bodyLength != null ? `${a.bodyLength}文字` : "本文未取得"} / {a.status}
              </div>
            </div>
            <button className="btn btn-primary btn-sm" disabled={busy === `a-${a.id}`}
              onClick={() => post("/article-manual-approve", { articleRequestId: a.id },
                `a-${a.id}`, `この記事を手動承認します:\n${a.qiitaUrl}\n-1pt 加算されます。`)}>
              手動承認
            </button>
          </div>
        ))}
      </Section>

      <section>
        <h3 style={s.h}>管理操作</h3>
        <div style={s.list}>
          <div style={s.row}>
            <span style={{ flex: 1 }}>朝活けじめステータスを削除 → 最新内容で再投稿します</span>
            <button className="btn btn-ghost btn-sm" disabled={busy === "sync-slack"}
              onClick={syncSlack}>
              {busy === "sync-slack" ? "更新中..." : "Slackを最新の状態にする"}
            </button>
          </div>
        </div>
      </section>

      <Section title="🕘 履歴 (直近20件)" empty="履歴なし" isEmpty={events.length === 0}>
        {events.map((e) => (
          <div key={e.id} style={s.row}>
            <span style={s.meta}>{e.occurredAt.slice(0, 16).replace("T", " ")}</span>
            <span style={{ flex: 1, marginLeft: "0.5rem" }}>
              <span style={s.badge}>{e.type}</span>
              {e.pointsDelta !== 0 && ` pt${e.pointsDelta > 0 ? "+" : ""}${e.pointsDelta}`}
              {e.ramenDelta !== 0 && ` 🌶${e.ramenDelta > 0 ? "+" : ""}${e.ramenDelta}`}
              {e.note && <span style={s.meta}> ({e.note})</span>}
            </span>
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
  error: { padding: "0.75rem", color: colors.danger, background: colors.dangerSubtle,
    borderRadius: "0.25rem", fontSize: "0.875rem" },
  notice: { padding: "0.75rem", color: colors.primaryHover, background: colors.primarySubtle,
    borderRadius: "0.25rem", fontSize: "0.875rem" },
  badge: { padding: "0.125rem 0.375rem", background: colors.primarySubtle,
    color: colors.primaryHover, borderRadius: "0.25rem",
    fontSize: "0.75rem", fontWeight: 500 },
};
