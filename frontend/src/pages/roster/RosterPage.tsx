import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { api } from "../../api";
import type { RosterMember } from "../../types";
import { colors } from "../../styles/tokens";
import { RosterDetailPanel } from "./RosterDetailPanel";
import { RosterColumnsModal } from "./RosterColumnsModal";

// 名簿管理 (member_roster) PR3-FE: 一覧表 read-only 表示。
// 列ソート / 検索 / 退会済み非表示トグルのみ実装する。編集系は PR4 以降。

type SortKey =
  | "name" | "nameKana" | "email" | "grade"
  | "slackName" | "joinedAt" | "status";
type SortDir = "asc" | "desc";

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "name", label: "名前" },
  { key: "nameKana", label: "フリガナ" },
  { key: "email", label: "メール" },
  { key: "grade", label: "学年" },
  { key: "slackName", label: "Slack 名" },
  { key: "joinedAt", label: "入会日" },
  { key: "status", label: "ステータス" },
];

// null は常に末尾に寄せる (asc/desc 両方で扱いを揃える)
function cmp(a: string | null, b: string | null, dir: SortDir): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const r = a.localeCompare(b, "ja");
  return dir === "asc" ? r : -r;
}

export function RosterPage({ eventId, actionId }: { eventId: string; actionId: string }) {
  const [members, setMembers] = useState<RosterMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [hideInactive, setHideInactive] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>("grade");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [selected, setSelected] = useState<RosterMember | null>(null);
  const [showCols, setShowCols] = useState(false);

  // hideInactive=false の時のみ includeInactive=1 を送る。
  useEffect(() => {
    let cancelled = false;
    setMembers(null);
    setError(null);
    api.roster.listMembers(actionId, { includeInactive: !hideInactive })
      .then((rows) => {
        if (!cancelled) setMembers(Array.isArray(rows) ? rows : []);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "読み込みに失敗しました");
        setMembers([]);
      });
    return () => { cancelled = true; };
  }, [actionId, hideInactive]);

  const visible = useMemo(() => {
    if (!members) return [];
    const q = search.trim().toLowerCase();
    const filtered = q
      ? members.filter((m) =>
          [m.name, m.nameKana, m.email, m.slackName]
            .filter((s): s is string => !!s)
            .some((s) => s.toLowerCase().includes(q)))
      : members.slice();
    filtered.sort((a, b) => cmp(a[sortKey], b[sortKey], sortDir));
    return filtered;
  }, [members, search, sortKey, sortDir]);

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortKey(k); setSortDir("asc"); }
  };

  return (
    <div style={{ padding: "1rem" }}>
      <div style={S.controls}>
        <input
          type="search" value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="名前 / フリガナ / メール / Slack 名を検索"
          aria-label="名簿を検索" style={S.search}
        />
        <label style={S.toggle}>
          <input type="checkbox" checked={hideInactive}
            onChange={(e) => setHideInactive(e.target.checked)} />
          <span>退会済みを非表示</span>
        </label>
        <button type="button" onClick={() => setShowCols(true)} style={S.colsBtn}>
          カスタム列管理
        </button>
      </div>

      {error && <div style={S.error}>{error}</div>}

      {members === null ? (
        <div style={{ color: colors.textSecondary }}>読み込み中...</div>
      ) : visible.length === 0 ? (
        <div style={S.empty}>
          {search ? "検索条件に一致するメンバーはいません。" : "まだメンバーが登録されていません。"}
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={S.table}>
            <thead><tr>
              {COLUMNS.map((c) => {
                const active = sortKey === c.key;
                const arrow = active ? (sortDir === "asc" ? "▲" : "▼") : "";
                const ariaSort = active
                  ? (sortDir === "asc" ? "ascending" : "descending") : "none";
                return (
                  <th key={c.key} style={S.th} aria-sort={ariaSort}>
                    <button type="button" onClick={() => toggleSort(c.key)}
                      style={S.thBtn} aria-label={`${c.label} で並び替え`}>
                      {c.label}<span style={S.arrow}>{arrow}</span>
                    </button>
                  </th>
                );
              })}
              <th style={S.th}>備考</th>
            </tr></thead>
            <tbody>
              {visible.map((m) => {
                const td: CSSProperties = m.status === "inactive"
                  ? { ...S.td, opacity: 0.55 } : S.td;
                return (
                  <tr
                    key={m.id} style={S.row} tabIndex={0} role="button"
                    aria-label={`${m.name} を編集`}
                    onClick={() => setSelected(m)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault(); setSelected(m);
                      }
                    }}
                  >
                    <td style={td}>{m.name}</td>
                    <td style={td}>{m.nameKana ?? "-"}</td>
                    <td style={td}>{m.email ?? "-"}</td>
                    <td style={td}>{m.grade ?? "-"}</td>
                    <td style={td}>{m.slackName ?? "-"}</td>
                    <td style={td}>{m.joinedAt ?? "-"}</td>
                    <td style={td}>
                      <span style={m.status === "active" ? S.bAct : S.bInact}>
                        {m.status === "active" ? "在籍" : "退会"}
                      </span>
                    </td>
                    <td style={td}>{m.note ?? "-"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {showCols && (
        <RosterColumnsModal actionId={actionId} onClose={() => setShowCols(false)} />
      )}
      {selected && (
        <RosterDetailPanel
          eventId={eventId} actionId={actionId} member={selected}
          onClose={() => setSelected(null)}
          onChanged={(next) => {
            setMembers((prev) => {
              if (!prev) return prev;
              if (next === null) return prev.filter((x) => x.id !== selected.id);
              return prev.map((x) => (x.id === next.id ? next : x));
            });
          }}
        />
      )}
    </div>
  );
}

// スタイル定義は単一 object に集約してインライン量を抑える。
const badge: CSSProperties = {
  display: "inline-block", padding: "0.1rem 0.5rem", borderRadius: "9999px",
  fontSize: "0.75rem", fontWeight: "bold",
};
const S = {
  controls: { display: "flex", alignItems: "center", gap: "1rem",
    marginBottom: "0.75rem", flexWrap: "wrap" } as CSSProperties,
  search: { flex: "1 1 280px", minWidth: 0, padding: "0.4rem 0.6rem",
    border: `1px solid ${colors.borderStrong}`, borderRadius: "0.375rem",
    fontSize: "0.875rem", background: colors.background, color: colors.text } as CSSProperties,
  toggle: { display: "inline-flex", alignItems: "center", gap: "0.4rem",
    fontSize: "0.875rem", color: colors.text, cursor: "pointer" } as CSSProperties,
  table: { width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" } as CSSProperties,
  th: { textAlign: "left", padding: "0.5rem 0.75rem", whiteSpace: "nowrap",
    borderBottom: `1px solid ${colors.borderStrong}`, background: colors.surface,
    color: colors.textSecondary, fontSize: "0.8rem", fontWeight: "bold" } as CSSProperties,
  thBtn: { background: "transparent", border: "none", padding: 0, font: "inherit",
    color: "inherit", cursor: "pointer", display: "inline-flex",
    alignItems: "center", gap: "0.25rem" } as CSSProperties,
  arrow: { width: "0.75em", display: "inline-block", color: colors.primary } as CSSProperties,
  td: { padding: "0.5rem 0.75rem", borderBottom: `1px solid ${colors.border}`,
    verticalAlign: "middle", whiteSpace: "nowrap" } as CSSProperties,
  row: { cursor: "pointer" } as CSSProperties,
  empty: { padding: "1.5rem", textAlign: "center", color: colors.textSecondary,
    background: colors.surface, border: `1px dashed ${colors.border}`,
    borderRadius: "0.375rem" } as CSSProperties,
  error: { padding: "0.5rem 0.75rem", background: colors.dangerSubtle,
    color: colors.danger, borderRadius: "0.375rem", fontSize: "0.875rem",
    marginBottom: "0.75rem" } as CSSProperties,
  bAct: { ...badge, background: colors.successSubtle, color: colors.success },
  bInact: { ...badge, background: colors.surface, color: colors.textSecondary },
  colsBtn: { padding: "0.4rem 0.8rem", background: colors.surface, color: colors.text,
    border: `1px solid ${colors.borderStrong}`, borderRadius: "0.375rem",
    fontSize: "0.875rem", cursor: "pointer" } as CSSProperties,
} as const;
