import { useEffect, useState, type CSSProperties } from "react";
import { api } from "../../api";
import type { RosterColumnType, RosterCustomColumn } from "../../types";
import { useToast } from "../../components/ui/Toast";
import { useConfirm } from "../../components/ui/ConfirmDialog";
import { colors } from "../../styles/tokens";

// 名簿管理 PR5-FE: カスタム列管理モーダル (追加 / 削除)。
// 列定義の編集 (label/type/options/sortOrder の inline 編集) と
// 値の表示・編集 (一覧表 / サイドパネル) は別 PR (PR5b) で扱う。
const TYPES: { v: RosterColumnType; label: string }[] = [
  { v: "text", label: "テキスト" }, { v: "number", label: "数値" },
  { v: "select", label: "選択肢" }, { v: "date", label: "日付" },
];
const opts2text = (j: string | null): string => {
  if (!j) return "";
  try { const a = JSON.parse(j); return Array.isArray(a) ? a.join(", ") : ""; }
  catch { return ""; }
};

type Draft = { columnKey: string; label: string; type: RosterColumnType; optionsText: string };
const EMPTY: Draft = { columnKey: "", label: "", type: "text", optionsText: "" };

export function RosterColumnsModal(
  { actionId, onClose }: { actionId: string; onClose: () => void },
) {
  const toast = useToast();
  const { confirm } = useConfirm();
  const [cols, setCols] = useState<RosterCustomColumn[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);

  useEffect(() => {
    let off = false;
    api.roster.listColumns(actionId)
      .then((rs) => !off && setCols(rs)).catch(() => !off && setCols([]));
    return () => { off = true; };
  }, [actionId]);
  useEffect(() => {
    const f = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, [onClose]);

  const refresh = async () => setCols(await api.roster.listColumns(actionId));

  const add = async () => {
    if (!draft.columnKey.trim() || !draft.label.trim()) {
      toast.error("キーとラベルは必須です"); return;
    }
    setBusy(true);
    try {
      await api.roster.createColumn(actionId, {
        columnKey: draft.columnKey.trim(), label: draft.label.trim(), type: draft.type,
        options: draft.type === "select"
          ? draft.optionsText.split(",").map((s) => s.trim()).filter(Boolean)
          : undefined,
        sortOrder: (cols?.length ?? 0) * 10,
      });
      setDraft(EMPTY);
      await refresh();
      toast.success("列を追加しました");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "追加に失敗しました");
    } finally { setBusy(false); }
  };

  const remove = async (c: RosterCustomColumn) => {
    const ok = await confirm({
      message: `列「${c.label}」を削除しますか？\nこの列に紐づく全メンバーの値も削除されます。`,
      variant: "danger", confirmLabel: "削除する",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.roster.deleteColumn(actionId, c.id);
      await refresh();
      toast.success("列を削除しました");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "削除に失敗しました");
    } finally { setBusy(false); }
  };

  return (
    <div style={S.ov} onClick={onClose} role="presentation">
      <div style={S.box} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="カスタム列管理">
        <header style={S.hd}>
          <h2 style={S.title}>カスタム列管理</h2>
          <button type="button" onClick={onClose} aria-label="閉じる" style={S.x}>×</button>
        </header>
        <div style={S.body}>
          {cols === null ? <div style={S.muted}>読み込み中...</div>
           : cols.length === 0 ? <div style={S.muted}>カスタム列はまだありません。</div>
           : <ul style={S.list}>{cols.map((c) => (
              <li key={c.id} style={S.item}>
                <span style={S.lbl}>{c.label}</span>
                <span style={S.meta}>
                  {TYPES.find((t) => t.v === c.type)?.label ?? c.type}
                  {c.type === "select" && c.optionsJson ? ` / ${opts2text(c.optionsJson)}` : ""}
                </span>
                <button type="button" onClick={() => remove(c)} disabled={busy}
                  aria-label={`${c.label} を削除`} style={S.del}>削除</button>
              </li>))}
            </ul>}
          <fieldset style={S.add}>
            <legend style={S.legend}>列を追加</legend>
            <input aria-label="新しい列のキー" placeholder="例: position" value={draft.columnKey}
              style={S.inp} disabled={busy} onChange={(e) => setDraft({ ...draft, columnKey: e.target.value })}/>
            <input aria-label="新しい列のラベル" placeholder="例: 役職" value={draft.label}
              style={S.inp} disabled={busy} onChange={(e) => setDraft({ ...draft, label: e.target.value })}/>
            <select aria-label="新しい列の型" value={draft.type} style={S.sel} disabled={busy}
              onChange={(e) => setDraft({ ...draft, type: e.target.value as RosterColumnType })}>
              {TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
            </select>
            {draft.type === "select" && (
              <input aria-label="新しい列の選択肢 (カンマ区切り)" placeholder="A, B, C" value={draft.optionsText}
                style={S.inp} disabled={busy} onChange={(e) => setDraft({ ...draft, optionsText: e.target.value })}/>
            )}
            <button type="button" onClick={add} disabled={busy} style={S.addBtn}>＋ 列を追加</button>
          </fieldset>
        </div>
      </div>
    </div>
  );
}

const ctl: CSSProperties = { padding: "0.35rem 0.55rem", border: `1px solid ${colors.borderStrong}`,
  borderRadius: "0.375rem", fontSize: "0.8rem", background: colors.background, color: colors.text };
const btn: CSSProperties = { padding: "0.35rem 0.7rem", borderRadius: "0.375rem",
  cursor: "pointer", fontSize: "0.8rem", border: "none" };
const flexRow: CSSProperties = { display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" };
const S: Record<string, CSSProperties> = {
  ov: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 100,
    display: "flex", alignItems: "center", justifyContent: "center" },
  box: { width: "min(560px, 96%)", maxHeight: "85vh", background: colors.background,
    borderRadius: "0.5rem", display: "flex", flexDirection: "column", boxShadow: "0 10px 30px rgba(0,0,0,0.2)" },
  hd: { ...flexRow, padding: "0.75rem 1rem", borderBottom: `1px solid ${colors.border}` },
  title: { margin: 0, fontSize: "1rem", flex: 1, color: colors.text },
  x: { background: "transparent", border: "none", fontSize: "1.5rem", cursor: "pointer",
    color: colors.textSecondary, lineHeight: 1 },
  body: { overflowY: "auto", padding: "1rem", display: "flex", flexDirection: "column", gap: "0.75rem" },
  muted: { color: colors.textSecondary, fontSize: "0.875rem" },
  list: { listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.3rem" },
  item: { ...flexRow, gap: "0.6rem", padding: "0.4rem 0.6rem", background: colors.surface,
    borderRadius: "0.375rem" },
  lbl: { fontSize: "0.875rem", color: colors.text, fontWeight: 500 },
  meta: { flex: 1, fontSize: "0.75rem", color: colors.textSecondary },
  inp: { ...ctl, flex: "1 1 120px", minWidth: 0 },
  sel: ctl,
  del: { ...btn, background: "transparent", color: colors.danger, border: `1px solid ${colors.danger}` },
  add: { ...flexRow, border: `1px dashed ${colors.border}`, borderRadius: "0.375rem", padding: "0.6rem" },
  legend: { fontSize: "0.75rem", color: colors.textSecondary, padding: "0 0.3rem" },
  addBtn: { ...btn, background: colors.primary, color: "#fff" },
};
