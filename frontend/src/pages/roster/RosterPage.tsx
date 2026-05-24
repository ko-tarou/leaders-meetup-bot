import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { api } from "../../api";
import type {
  RosterCustomColumn, RosterMember, RosterMemberValue,
} from "../../types";
import { EmptyState } from "../../components/EmptyState";
import { useToast } from "../../components/ui/Toast";
import { useIsMobile } from "../../hooks/useIsMobile";
import { colors } from "../../styles/tokens";
import { RosterDetailPanel } from "./RosterDetailPanel";
import { RosterColumnsModal } from "./RosterColumnsModal";
import { RosterImportModal } from "./RosterImportModal";
import { RosterMemberAddModal } from "./RosterMemberAddModal";
import { formatCustomValue } from "./customValue";

// 名簿管理 (member_roster) PR3-FE: 一覧表 read-only 表示。
// 列ソート / 検索 / 退会済み非表示トグルのみ実装する。編集系は PR4 以降。
// PR5b: カスタム列を固定列の後ろに sortOrder 順で表示 (read-only)。
// 値編集はサイドパネル側で行う。

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
  const isMobile = useIsMobile();
  const [members, setMembers] = useState<RosterMember[] | null>(null);
  const [customCols, setCustomCols] = useState<RosterCustomColumn[]>([]);
  // values は (memberId,columnId) → parsed value のマップで持つ。
  const [valueMap, setValueMap] = useState<Map<string, unknown>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [hideInactive, setHideInactive] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>("grade");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [selected, setSelected] = useState<RosterMember | null>(null);
  const [showCols, setShowCols] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  // panel 内でカスタム値を編集したら increment → 値を再取得する。
  // 取り込み / 追加モーダル close 時にも increment して名簿を再 fetch する。
  const [valuesVersion, setValuesVersion] = useState(0);
  // PR4 (2026-05): 「Slack 同期」ボタンの実行中フラグ。同期完了後に
  // valuesVersion を increment して名簿全体を refetch する。
  const [syncing, setSyncing] = useState(false);
  const toast = useToast();

  // PR4 (2026-05): Slack 表示名の一括同期。
  // 進行中はボタンを disabled にし、完了後はトーストで結果を出してから refetch。
  // 失敗 (HTTP エラー) でも fail-soft でエラートーストを出すだけに留める。
  const handleSyncSlackNames = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const r = await api.roster.syncSlackNames(eventId, actionId);
      toast.success(
        `Slack 表示名を同期しました (${r.updated} 件更新 / ${r.unchanged} 件変更なし / ${r.errors.length} 件エラー)`,
      );
      setValuesVersion((n) => n + 1);
    } catch (e: unknown) {
      toast.error(
        e instanceof Error ? `Slack 同期に失敗しました: ${e.message}` : "Slack 同期に失敗しました",
      );
    } finally {
      setSyncing(false);
    }
  };

  // hideInactive=false の時のみ includeInactive=1 を送る。
  // カスタム列 / 値も同時に再取得する (列追加・削除モーダル close 後の整合性のため)。
  useEffect(() => {
    let cancelled = false;
    setMembers(null);
    setError(null);
    // Chromium 系ブラウザ (Chrome / Dia) で 3 並行 fetch が
    // "Provisional headers" 状態で失敗する事象を回避するため sequential 化。
    // Safari では並行でも問題ないが、互換性のため全環境で順次取得する。
    (async () => {
      try {
        const rows = await api.roster.listMembers(eventId, actionId, { includeInactive: !hideInactive });
        if (cancelled) return;
        const cols = await api.roster.listColumns(eventId, actionId).catch(() => [] as RosterCustomColumn[]);
        if (cancelled) return;
        const vals = await api.roster.listValues(eventId, actionId).catch(() => [] as RosterMemberValue[]);
        if (cancelled) return;
        setMembers(Array.isArray(rows) ? rows : []);
        setCustomCols(cols);
        const m = new Map<string, unknown>();
        for (const v of vals) {
          try { m.set(`${v.memberId}:${v.columnId}`, JSON.parse(v.valueJson)); }
          catch { /* skip invalid JSON */ }
        }
        setValueMap(m);
      } catch (e: unknown) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "読み込みに失敗しました");
        setMembers([]);
      }
    })();
    return () => { cancelled = true; };
  }, [eventId, actionId, hideInactive, showCols, valuesVersion]);

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

  // mobile では検索ボックスを 100% 幅にし、ボタン群は折り返したまま
  // 全幅広げて tap し易くする。
  const mobileBtn: CSSProperties | undefined = isMobile
    ? { flex: "1 1 calc(50% - 0.5rem)", minHeight: 40 }
    : undefined;

  return (
    <div style={{ padding: isMobile ? "0.75rem" : "1rem" }}>
      <div style={S.controls}>
        <input
          type="search" value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="名前 / フリガナ / メール / Slack 名を検索"
          aria-label="名簿を検索"
          style={isMobile ? { ...S.search, flexBasis: "100%" } : S.search}
        />
        <label style={S.toggle}>
          <input type="checkbox" checked={hideInactive}
            onChange={(e) => setHideInactive(e.target.checked)} />
          <span>退会済みを非表示</span>
        </label>
        <button
          type="button"
          onClick={() => setShowImport(true)}
          style={{ ...S.primaryBtn, ...mobileBtn }}
        >
          参加届を提出した人から取り込み
        </button>
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          style={{ ...S.primaryBtn, ...mobileBtn }}
        >
          ＋ メンバー追加
        </button>
        <button
          type="button"
          onClick={() => setShowCols(true)}
          style={{ ...S.colsBtn, ...mobileBtn }}
        >
          カスタム列管理
        </button>
        {/* PR4 (2026-05): Slack 表示名一括同期。slack_user_id 持ちメンバーのみが対象。 */}
        <button
          type="button"
          onClick={handleSyncSlackNames}
          disabled={syncing}
          style={{ ...(syncing ? S.syncBtnBusy : S.colsBtn), ...mobileBtn }}
          aria-busy={syncing}
        >
          {syncing ? "同期中..." : "Slack 同期"}
        </button>
      </div>

      {error && <div style={S.error}>{error}</div>}

      {members === null ? (
        <div style={{ color: colors.textSecondary }}>読み込み中...</div>
      ) : visible.length === 0 ? (
        search ? (
          // 検索 hit ゼロは「クリアする」だけの軽い空状態に留める。
          // 初期状態のフル CTA とは性格が違うので EmptyState で差別化する。
          <EmptyState
            icon="🔍"
            title="検索条件に一致するメンバーはいません"
            description="キーワードを変えるか、検索をクリアしてください。"
            primaryAction={{
              label: "検索をクリア",
              onClick: () => setSearch(""),
            }}
          />
        ) : (
          <EmptyState
            icon="👥"
            title="まだメンバーが登録されていません"
            description="参加届を提出した人を取り込むか、手動でメンバーを追加してください。"
            primaryAction={{
              label: "＋ メンバー追加",
              onClick: () => setShowAdd(true),
            }}
            secondaryAction={{
              label: "参加届から取り込み",
              onClick: () => setShowImport(true),
            }}
          />
        )
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
              {customCols.map((c) => (
                <th key={c.id} style={S.th} title={c.columnKey}>{c.label}</th>
              ))}
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
                    {customCols.map((c) => (
                      <td key={c.id} style={td}>
                        {formatCustomValue(c.type, valueMap.get(`${m.id}:${c.id}`))}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {showCols && (
        <RosterColumnsModal
          eventId={eventId} actionId={actionId}
          onClose={() => setShowCols(false)}
        />
      )}
      {showImport && (
        <RosterImportModal
          eventId={eventId} actionId={actionId}
          onClose={() => setShowImport(false)}
          onImported={() => setValuesVersion((n) => n + 1)}
        />
      )}
      {showAdd && (
        <RosterMemberAddModal
          eventId={eventId} actionId={actionId}
          onClose={() => setShowAdd(false)}
          onCreated={(m) =>
            setMembers((prev) => (prev ? [...prev, m] : [m]))}
        />
      )}
      {selected && (
        <RosterDetailPanel
          eventId={eventId} actionId={actionId} member={selected}
          customColumns={customCols}
          onClose={() => setSelected(null)}
          onChanged={(next) => {
            setMembers((prev) => {
              if (!prev) return prev;
              if (next === null) return prev.filter((x) => x.id !== selected.id);
              return prev.map((x) => (x.id === next.id ? next : x));
            });
          }}
          onValuesChanged={() => setValuesVersion((n) => n + 1)}
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
  primaryBtn: { padding: "0.4rem 0.8rem", background: colors.primary, color: "#fff",
    border: "none", borderRadius: "0.375rem", fontSize: "0.875rem",
    cursor: "pointer" } as CSSProperties,
  // PR4 (2026-05): 「Slack 同期」進行中のボタン状態。
  // colsBtn と同じ見た目だが cursor を変えて in-flight を明示する。
  syncBtnBusy: { padding: "0.4rem 0.8rem", background: colors.surface,
    color: colors.textSecondary, border: `1px solid ${colors.borderStrong}`,
    borderRadius: "0.375rem", fontSize: "0.875rem",
    cursor: "wait" } as CSSProperties,
} as const;
