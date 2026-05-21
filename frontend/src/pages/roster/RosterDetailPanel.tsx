import { useEffect, useState, type CSSProperties } from "react";
import { api } from "../../api";
import type { RosterMember, SlackRole } from "../../types";
import { useToast } from "../../components/ui/Toast";
import { useConfirm } from "../../components/ui/ConfirmDialog";
import { colors } from "../../styles/tokens";

// 名簿管理 PR4-FE: メンバー編集サイドパネル。
// 行クリックで右からスライドイン → フィールド編集 + ロール選択 + 退会。
// セル単位インライン編集は別 PR (PR4-b 予定)。

type Editable = "name" | "nameKana" | "email" | "grade" | "slackName" | "note";
const FIELDS: { key: Editable; label: string }[] = [
  { key: "name", label: "名前" }, { key: "nameKana", label: "フリガナ" },
  { key: "email", label: "メール" }, { key: "grade", label: "学年" },
  { key: "slackName", label: "Slack 名" }, { key: "note", label: "備考" },
];

export function RosterDetailPanel({
  eventId, actionId, member, onClose, onChanged,
}: {
  eventId: string; actionId: string; member: RosterMember;
  onClose: () => void; onChanged: (next: RosterMember | null) => void;
}) {
  const toast = useToast();
  const { confirm } = useConfirm();
  const [draft, setDraft] = useState<RosterMember>(member);
  const [roles, setRoles] = useState<SlackRole[] | null>(null);
  const [roleIds, setRoleIds] = useState<Set<string>>(new Set());
  const [initialRoleIds, setInitialRoleIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(member), [member]);
  useEffect(() => {
    let off = false;
    Promise.all([
      api.roles.list(eventId, actionId).catch(() => [] as SlackRole[]),
      api.roster.getMemberRoles(eventId, actionId, member.id)
        .catch(() => ({ roleIds: [] as string[] })),
    ]).then(([rs, mr]) => {
      if (off) return;
      setRoles(rs); setRoleIds(new Set(mr.roleIds)); setInitialRoleIds(mr.roleIds);
    });
    return () => { off = true; };
  }, [eventId, actionId, member.id]);
  useEffect(() => {
    const f = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, [onClose]);

  const save = async () => {
    setSaving(true);
    // name は non-null。空文字は無視 (no-op)。他フィールドは "" を null として送る。
    const patch: Partial<RosterMember> = {};
    for (const { key } of FIELDS) {
      const raw = (draft[key] ?? "") as string;
      const next: string | null = key === "name" ? raw : raw === "" ? null : raw;
      if (next !== member[key] && !(key === "name" && next === ""))
        (patch as Record<string, unknown>)[key] = next;
    }
    try {
      let updated = member;
      if (Object.keys(patch).length > 0) {
        updated = await api.roster.updateMember(actionId, member.id, patch);
      }
      const target = Array.from(roleIds).sort();
      if (initialRoleIds.slice().sort().join(",") !== target.join(",")) {
        await api.roster.setMemberRoles(eventId, actionId, member.id, target);
      }
      onChanged(updated);
      toast.success("保存しました");
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存に失敗しました");
    } finally { setSaving(false); }
  };

  const remove = async () => {
    const ok = await confirm({
      message: `「${member.name}」を退会扱いにしますか？一覧から非表示になります。`,
      variant: "danger", confirmLabel: "退会させる",
    });
    if (!ok) return;
    setSaving(true);
    try {
      await api.roster.deleteMember(actionId, member.id);
      onChanged(null);
      toast.success("退会扱いにしました");
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "退会処理に失敗しました");
      setSaving(false);
    }
  };

  return (
    <div style={S.overlay} onClick={onClose} role="presentation">
      <aside style={S.panel} onClick={(e) => e.stopPropagation()}
        role="dialog" aria-label={`${member.name} の編集`}>
        <header style={S.header}>
          <h2 style={S.title}>{member.name}</h2>
          <button type="button" onClick={onClose} aria-label="閉じる"
            style={S.iconBtn}>×</button>
        </header>
        <div style={S.body}>
          {FIELDS.map(({ key, label }) => (
            <label key={key} style={S.field}>
              <span style={S.lab}>{label}</span>
              <input type="text" value={draft[key] ?? ""} style={S.input}
                onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}/>
            </label>
          ))}
          <fieldset style={S.field}>
            <legend style={S.lab}>ロール</legend>
            {roles === null ? <span style={S.muted}>読み込み中...</span>
             : roles.length === 0 ? <span style={S.muted}>ロール未定義</span>
             : roles.map((r) => (
              <label key={r.id} style={S.row}>
                <input type="checkbox" checked={roleIds.has(r.id)}
                  onChange={(e) => {
                    const n = new Set(roleIds);
                    if (e.target.checked) n.add(r.id); else n.delete(r.id);
                    setRoleIds(n);
                  }}/>
                <span>{r.name}{r.parentRoleId ? " (子)" : ""}</span>
              </label>
            ))}
          </fieldset>
        </div>
        <footer style={S.footer}>
          <button type="button" onClick={remove} disabled={saving}
            style={S.danger}>退会させる</button>
          <span style={{ flex: 1 }} />
          <button type="button" onClick={onClose} disabled={saving}
            style={S.cancel}>キャンセル</button>
          <button type="button" onClick={save} disabled={saving} style={S.save}>
            {saving ? "保存中..." : "保存"}
          </button>
        </footer>
      </aside>
    </div>
  );
}

const btn: CSSProperties = { padding: "0.4rem 0.9rem", borderRadius: "0.375rem",
  cursor: "pointer", fontSize: "0.875rem" };
const S: Record<string, CSSProperties> = {
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)",
    zIndex: 100, display: "flex", justifyContent: "flex-end" },
  panel: { width: "min(420px, 100%)", height: "100%", background: colors.background,
    display: "flex", flexDirection: "column",
    boxShadow: "-4px 0 16px rgba(0,0,0,0.15)" },
  header: { display: "flex", alignItems: "center", padding: "0.75rem 1rem",
    borderBottom: `1px solid ${colors.border}` },
  title: { margin: 0, fontSize: "1rem", flex: 1, color: colors.text },
  iconBtn: { background: "transparent", border: "none", fontSize: "1.5rem",
    cursor: "pointer", color: colors.textSecondary, lineHeight: 1 },
  body: { flex: 1, overflowY: "auto", padding: "1rem", display: "flex",
    flexDirection: "column", gap: "0.75rem" },
  field: { display: "flex", flexDirection: "column", gap: "0.25rem",
    border: "none", padding: 0, margin: 0 },
  lab: { fontSize: "0.75rem", color: colors.textSecondary },
  input: { padding: "0.4rem 0.6rem", border: `1px solid ${colors.borderStrong}`,
    borderRadius: "0.375rem", fontSize: "0.875rem", background: colors.background,
    color: colors.text },
  row: { display: "flex", alignItems: "center", gap: "0.4rem",
    fontSize: "0.875rem", color: colors.text },
  muted: { color: colors.textSecondary },
  footer: { display: "flex", alignItems: "center", gap: "0.5rem",
    padding: "0.75rem 1rem", borderTop: `1px solid ${colors.border}` },
  save: { ...btn, background: colors.primary, color: "#fff", border: "none" },
  cancel: { ...btn, background: colors.surface, color: colors.text,
    border: `1px solid ${colors.borderStrong}` },
  danger: { ...btn, background: "transparent", color: colors.danger,
    border: `1px solid ${colors.danger}` },
};
