import { useEffect, useState, type CSSProperties } from "react";
import { api } from "../../api";
import type { RosterImportCandidate } from "../../types";
import { useToast } from "../../components/ui/Toast";
import { useIsMobile } from "../../hooks/useIsMobile";
import { colors } from "../../styles/tokens";

// 名簿管理 PR6-FE: 取り込みモーダル。
// PR3 (2026-05): 取り込み元を「合格者 (applications.passed)」から
// 「参加届を提出した人 (participation_forms.submitted)」に変更。
// Slack 情報 (slackEmail / slackName / slackUserId) も合わせて createMember に渡す。
// 一括 import API は無いので createMember を for-loop で叩く (失敗は集計表示)。

export function RosterImportModal({
  eventId, actionId, onClose, onImported,
}: {
  eventId: string; actionId: string;
  onClose: () => void; onImported: () => void;
}) {
  const toast = useToast();
  const isMobile = useIsMobile();
  const [cands, setCands] = useState<RosterImportCandidate[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const busy = progress !== null;

  useEffect(() => {
    let off = false;
    api.roster.listImportCandidates(eventId, actionId)
      .then((r) => !off && setCands(r))
      .catch((e: unknown) => !off
        && setLoadError(e instanceof Error ? e.message : "候補の取得に失敗しました"));
    return () => { off = true; };
  }, [eventId, actionId]);

  useEffect(() => {
    const f = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, [onClose, busy]);

  const allChecked = cands !== null && cands.length > 0 && picked.size === cands.length;
  const toggleAll = () => {
    if (!cands) return;
    setPicked(allChecked ? new Set() : new Set(cands.map((c) => c.id)));
  };
  const toggleOne = (id: string) => {
    const n = new Set(picked);
    if (n.has(id)) n.delete(id); else n.add(id);
    setPicked(n);
  };

  const doImport = async () => {
    if (!cands || picked.size === 0) return;
    const targets = cands.filter((c) => picked.has(c.id));
    setProgress({ done: 0, total: targets.length });
    setErrors([]);
    const failed: string[] = [];
    let done = 0;
    for (const t of targets) {
      try {
        // PR3 (2026-05): 参加届ベースなので Slack 情報も一緒に保存する。
        await api.roster.createMember(eventId, actionId, {
          name: t.name,
          email: t.email,
          slackEmail: t.slackEmail ?? undefined,
          slackName: t.slackName ?? undefined,
          slackUserId: t.slackUserId ?? undefined,
          joinedAt: t.submittedAt,
        });
      } catch (e) {
        failed.push(`${t.name}: ${e instanceof Error ? e.message : "失敗"}`);
      }
      done += 1;
      setProgress({ done, total: targets.length });
    }
    setProgress(null);
    if (failed.length > 0) {
      setErrors(failed);
      toast.error(`${failed.length} 件の取り込みに失敗しました`);
    } else {
      toast.success(`${targets.length} 件を取り込みました`);
    }
    if (done > failed.length) onImported();
    if (failed.length === 0) onClose();
  };

  // mobile では全画面 modal にして tap target を最大化する
  const ovStyle: CSSProperties = isMobile
    ? { ...S.ov, alignItems: "stretch" }
    : S.ov;
  const boxStyle: CSSProperties = isMobile
    ? { ...S.box, width: "100%", maxWidth: "100%", maxHeight: "100vh",
        borderRadius: 0, height: "100%" }
    : S.box;

  return (
    <div style={ovStyle} onClick={() => !busy && onClose()} role="presentation">
      {/* HitoLink DS: anim-pop-in でモーダルを spring 着地させる。 */}
      <div style={boxStyle} onClick={(e) => e.stopPropagation()}
        className="anim-pop-in"
        role="dialog" aria-modal="true" aria-label="参加届を提出した人から取り込み">
        <header style={S.hd}>
          <h2 style={S.title}>参加届を提出した人から取り込み</h2>
          <button type="button" onClick={onClose} disabled={busy}
            aria-label="閉じる" style={S.x}>×</button>
        </header>
        <div style={S.body}>
          {loadError && <div style={S.err}>{loadError}</div>}
          {cands === null ? <div style={S.muted}>読み込み中...</div>
           : cands.length === 0 ? (
            <div style={S.muted}>
              取り込み可能な参加届はありません。<br />
              (まだ提出がない / すでに全員取り込み済み)
            </div>
          ) : (
            // mobile では 5 列テーブルが横スクロールでも読みづらいため、
            // ラッパで overflow-x:auto を付与して指でスワイプ可能にする
            <div style={{ overflowX: "auto" }}>
            <table style={S.table}>
              <thead><tr>
                <th style={S.th}>
                  <input type="checkbox" aria-label="すべて選択"
                    checked={allChecked} disabled={busy} onChange={toggleAll} />
                </th>
                <th style={S.th}>名前</th>
                <th style={S.th}>メール</th>
                <th style={S.th}>Slack 名</th>
                <th style={S.th}>Slack ID</th>
              </tr></thead>
              <tbody>
                {cands.map((c) => (
                  <tr key={c.id}>
                    <td style={S.td}>
                      <input type="checkbox" aria-label={`${c.name} を選択`}
                        checked={picked.has(c.id)} disabled={busy}
                        onChange={() => toggleOne(c.id)} />
                    </td>
                    <td style={S.td}>{c.name}</td>
                    <td style={S.td}>{c.email}</td>
                    <td style={S.td}>{c.slackName ?? "-"}</td>
                    <td style={S.td}>
                      {c.slackUserId ?? (
                        <span style={S.muted}>未解決</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
          {progress && (
            <div style={S.progress} role="status" aria-live="polite">
              取り込み中... {progress.done} / {progress.total} 件完了
            </div>
          )}
          {errors.length > 0 && (
            <div style={S.errList} role="alert">
              <strong>失敗 {errors.length} 件:</strong>
              <ul style={{ margin: "0.25rem 0 0 1rem", padding: 0 }}>
                {errors.map((m, i) => <li key={i}>{m}</li>)}
              </ul>
            </div>
          )}
        </div>
        <footer
          style={{
            ...S.ft,
            // mobile はボタンの折り返しを許可してタップ領域を広く確保する
            flexWrap: isMobile ? "wrap" : "nowrap",
            // UX-PR3 (D+E): mobile では sticky bottom 化して、長い候補リストを
            // スクロールしてもボタンが常に画面下に張り付くようにする。
            // (キャンセルは右上 × に統一済みなので、primary 1 個だけを表示)
            ...(isMobile
              ? {
                  position: "sticky",
                  bottom: 0,
                  background: colors.background,
                  zIndex: 10,
                }
              : {}),
          }}
        >
          <span style={S.muted}>
            {cands && cands.length > 0 ? `${picked.size} / ${cands.length} 件選択` : ""}
          </span>
          {!isMobile && <span style={{ flex: 1 }} />}
          {/*
            UX-PR3 (D): 右上 × と被るため下部「キャンセル」は削除。
            破棄系は × / overlay クリック / ESC キーで一貫させる。
          */}
          {/* HitoLink DS: 主アクションを btn-primary に。 */}
          <button
            type="button"
            onClick={doImport}
            disabled={busy || picked.size === 0}
            className="btn btn-primary btn-sm"
            style={{
              ...S.primary,
              flex: isMobile ? "1 1 100%" : undefined,
              minHeight: 40,
            }}
          >
            {busy ? "取り込み中..." : `選択を追加 (${picked.size})`}
          </button>
        </footer>
      </div>
    </div>
  );
}

const btn: CSSProperties = { padding: "0.4rem 0.9rem", borderRadius: "0.375rem",
  cursor: "pointer", fontSize: "0.875rem" };
const errBox: CSSProperties = { padding: "0.5rem 0.75rem",
  background: colors.dangerSubtle, color: colors.danger,
  borderRadius: "0.375rem", fontSize: "0.875rem" };
const S: Record<string, CSSProperties> = {
  ov: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 100,
    display: "flex", alignItems: "center", justifyContent: "center" },
  box: { width: "min(720px, 96%)", maxHeight: "85vh", background: colors.background,
    borderRadius: "0.5rem", display: "flex", flexDirection: "column",
    boxShadow: "0 10px 30px rgba(0,0,0,0.2)" },
  hd: { display: "flex", alignItems: "center", padding: "0.75rem 1rem",
    borderBottom: `1px solid ${colors.border}` },
  title: { margin: 0, fontSize: "1rem", flex: 1, color: colors.text },
  x: { background: "transparent", border: "none", fontSize: "1.5rem", cursor: "pointer",
    color: colors.textSecondary, lineHeight: 1 },
  body: { flex: 1, overflowY: "auto", padding: "1rem", display: "flex",
    flexDirection: "column", gap: "0.75rem" },
  muted: { color: colors.textSecondary, fontSize: "0.875rem" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" },
  th: { textAlign: "left", padding: "0.4rem 0.6rem", whiteSpace: "nowrap",
    borderBottom: `1px solid ${colors.borderStrong}`, background: colors.surface,
    color: colors.textSecondary, fontSize: "0.75rem" },
  td: { padding: "0.4rem 0.6rem", borderBottom: `1px solid ${colors.border}`,
    color: colors.text },
  progress: { padding: "0.5rem 0.75rem", background: colors.surface,
    color: colors.text, borderRadius: "0.375rem", fontSize: "0.875rem" },
  err: errBox,
  errList: { ...errBox, fontSize: "0.8rem" },
  ft: { display: "flex", alignItems: "center", gap: "0.5rem",
    padding: "0.75rem 1rem", borderTop: `1px solid ${colors.border}` },
  primary: { ...btn, background: colors.primary, color: "#fff", border: "none" },
  cancel: { ...btn, background: colors.surface, color: colors.text,
    border: `1px solid ${colors.borderStrong}` },
};
