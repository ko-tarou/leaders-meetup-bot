import { useEffect, useState, type CSSProperties } from "react";
import { api } from "../../api";
import type { RosterMember } from "../../types";
import { useToast } from "../../components/ui/Toast";
import { useIsMobile } from "../../hooks/useIsMobile";
import { colors } from "../../styles/tokens";

// 名簿管理 PR6-FE: メンバー手動追加モーダル。
// シンプルなフォーム (name 必須 + 任意項目) を 1 件 POST する。
// 既存 RosterDetailPanel は「既存メンバーの編集」専用なので別コンポーネントで持つ。

type Field = "name" | "nameKana" | "email" | "grade" | "slackName" | "joinedAt" | "note";
type Draft = Record<Field, string>;
const EMPTY: Draft = {
  name: "", nameKana: "", email: "", grade: "", slackName: "", joinedAt: "", note: "",
};
const FIELDS: { key: Field; label: string; type?: string; required?: boolean }[] = [
  { key: "name", label: "名前", required: true },
  { key: "nameKana", label: "フリガナ" },
  { key: "email", label: "メール", type: "email" },
  { key: "grade", label: "学年" },
  { key: "slackName", label: "Slack 名" },
  { key: "joinedAt", label: "入会日", type: "date" },
  { key: "note", label: "備考" },
];

// 緩い RFC5322 簡略チェック (空文字は許容、簡素な誤入力をブロック)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function RosterMemberAddModal({
  eventId, actionId, onClose, onCreated,
}: {
  eventId: string;
  actionId: string;
  onClose: () => void;
  onCreated: (member: RosterMember) => void;
}) {
  const toast = useToast();
  const isMobile = useIsMobile();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const f = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, [onClose, busy]);

  const set = (k: Field, v: string) => setDraft({ ...draft, [k]: v });

  const submit = async () => {
    const name = draft.name.trim();
    if (!name) { toast.error("名前は必須です"); return; }
    const email = draft.email.trim();
    if (email && !EMAIL_RE.test(email)) {
      toast.error("メール形式が正しくありません"); return;
    }
    setBusy(true);
    try {
      const empty2null = (s: string): string | null => (s.trim() === "" ? null : s.trim());
      const created = await api.roster.createMember(eventId, actionId, {
        name,
        nameKana: empty2null(draft.nameKana),
        email: empty2null(draft.email),
        grade: empty2null(draft.grade),
        slackName: empty2null(draft.slackName),
        joinedAt: empty2null(draft.joinedAt),
        note: empty2null(draft.note),
      });
      onCreated(created);
      toast.success("メンバーを追加しました");
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "追加に失敗しました");
    } finally { setBusy(false); }
  };

  // mobile では全画面 modal にし、フォーム入力欄を画面端まで広げる
  const ovStyle: CSSProperties = isMobile
    ? { ...S.ov, alignItems: "stretch" }
    : S.ov;
  const boxStyle: CSSProperties = isMobile
    ? { ...S.box, width: "100%", maxWidth: "100%", maxHeight: "100vh",
        height: "100%", borderRadius: 0 }
    : S.box;

  return (
    <div style={ovStyle} onClick={() => !busy && onClose()} role="presentation">
      <div style={boxStyle} onClick={(e) => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-label="メンバー追加">
        <header style={S.hd}>
          <h2 style={S.title}>メンバーを追加</h2>
          <button type="button" onClick={onClose} disabled={busy}
            aria-label="閉じる" style={S.x}>×</button>
        </header>
        <div style={S.body}>
          {FIELDS.map(({ key, label, type, required }) => (
            <label key={key} style={S.field}>
              <span style={S.lab}>{label}{required ? " *" : ""}</span>
              <input type={type ?? "text"} value={draft[key]} style={S.input}
                aria-label={label} disabled={busy} required={required}
                onChange={(e) => set(key, e.target.value)} />
            </label>
          ))}
        </div>
        <footer style={S.ft}>
          {!isMobile && <span style={{ flex: 1 }} />}
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            style={{
              ...S.cancel,
              flex: isMobile ? "1 1 calc(50% - 0.25rem)" : undefined,
              minHeight: 40,
            }}
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            style={{
              ...S.primary,
              flex: isMobile ? "1 1 calc(50% - 0.25rem)" : undefined,
              minHeight: 40,
            }}
          >
            {busy ? "追加中..." : "追加"}
          </button>
        </footer>
      </div>
    </div>
  );
}

const btn: CSSProperties = { padding: "0.4rem 0.9rem", borderRadius: "0.375rem",
  cursor: "pointer", fontSize: "0.875rem" };
const S: Record<string, CSSProperties> = {
  ov: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 100,
    display: "flex", alignItems: "center", justifyContent: "center" },
  box: { width: "min(480px, 96%)", maxHeight: "85vh", background: colors.background,
    borderRadius: "0.5rem", display: "flex", flexDirection: "column",
    boxShadow: "0 10px 30px rgba(0,0,0,0.2)" },
  hd: { display: "flex", alignItems: "center", padding: "0.75rem 1rem",
    borderBottom: `1px solid ${colors.border}` },
  title: { margin: 0, fontSize: "1rem", flex: 1, color: colors.text },
  x: { background: "transparent", border: "none", fontSize: "1.5rem", cursor: "pointer",
    color: colors.textSecondary, lineHeight: 1 },
  body: { flex: 1, overflowY: "auto", padding: "1rem", display: "flex",
    flexDirection: "column", gap: "0.6rem" },
  field: { display: "flex", flexDirection: "column", gap: "0.2rem" },
  lab: { fontSize: "0.75rem", color: colors.textSecondary },
  input: { padding: "0.4rem 0.6rem", border: `1px solid ${colors.borderStrong}`,
    borderRadius: "0.375rem", fontSize: "0.875rem", background: colors.background,
    color: colors.text },
  ft: { display: "flex", alignItems: "center", gap: "0.5rem",
    padding: "0.75rem 1rem", borderTop: `1px solid ${colors.border}` },
  primary: { ...btn, background: colors.primary, color: "#fff", border: "none" },
  cancel: { ...btn, background: colors.surface, color: colors.text,
    border: `1px solid ${colors.borderStrong}` },
};
