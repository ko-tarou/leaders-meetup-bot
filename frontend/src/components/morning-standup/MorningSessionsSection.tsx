import {
  useCallback, useEffect, useState, type CSSProperties,
} from "react";
import { request } from "../../api/client";
import { colors } from "../../styles/tokens";

// 朝勉強会の「回 (session)」スケジュール管理 (Feature ①)。
// 各回 = { sessionNo, date, theme, content }。レビュアー (朝活メンバー) が
// 記事内容を「その回の内容」と照合できるよう、回ごとの内容を記録する。
// けじめ記事は提出日と同じ date の回に自動で紐付く (BE 側 resolveSessionId)。

type Session = {
  id: string;
  sessionNo: number;
  date: string;
  theme: string;
  content: string | null;
};

function todayJst(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

export function MorningSessionsSection({ eventId, actionId }: {
  eventId: string; actionId: string;
}) {
  const base = `/orgs/${eventId}/actions/${actionId}/morning-attendance/sessions`;
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sessionNo, setSessionNo] = useState("");
  const [date, setDate] = useState<string>(todayJst);
  const [theme, setTheme] = useState("");
  const [content, setContent] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await request<Session[]>(base);
      setSessions(Array.isArray(list) ? list : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed");
    }
  }, [base]);
  useEffect(() => { void load(); }, [load]);

  const add = async () => {
    const no = Number(sessionNo);
    if (!Number.isInteger(no) || no < 1) {
      setError("回番号は 1 以上の整数で入力してください");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await request(base, {
        method: "POST",
        body: JSON.stringify({
          sessionNo: no, date, theme: theme.trim(),
          content: content.trim() || undefined,
        }),
      });
      setSessionNo("");
      setTheme("");
      setContent("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "回の追加に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string, no: number) => {
    if (!confirm(`第${no}回を削除します。よろしいですか？`)) return;
    setBusy(true);
    try {
      await request(`${base}/${id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "削除に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  if (sessions === null) return <div style={s.hint}>読み込み中...</div>;

  return (
    <section>
      <h3 style={s.h}>回 (セッション) スケジュール</h3>
      <p style={s.intro}>
        各回の開催日・テーマ・その日の内容を記録します。けじめ記事は提出日と同じ
        日付の回に自動で紐付き、レビュアーが内容を照合できます。
      </p>
      {error && <div style={s.error}>エラー: {error}</div>}

      <div style={s.list}>
        {sessions.length === 0 ? (
          <div style={s.empty}>まだ回が登録されていません。</div>
        ) : (
          sessions.map((x) => (
            <div key={x.id} style={s.row}>
              <span style={{ fontWeight: 600, minWidth: "4rem" }}>
                第{x.sessionNo}回
              </span>
              <span style={s.meta}>{x.date}</span>
              <span style={{ flex: 1 }}>
                {x.theme || "(テーマ未設定)"}
                {x.content ? ` — ${x.content}` : ""}
              </span>
              <button
                className="btn btn-ghost btn-sm"
                disabled={busy}
                onClick={() => remove(x.id, x.sessionNo)}
                aria-label={`第${x.sessionNo}回を削除`}
              >
                削除
              </button>
            </div>
          ))
        )}
      </div>

      <div style={s.form}>
        <input
          type="number" min={1} value={sessionNo} placeholder="回番号"
          onChange={(e) => setSessionNo(e.target.value)}
          aria-label="回番号" style={{ ...s.input, width: "6rem" }}
        />
        <input
          type="date" value={date} onChange={(e) => setDate(e.target.value)}
          aria-label="開催日" style={s.input}
        />
        <input
          type="text" value={theme} placeholder="テーマ"
          onChange={(e) => setTheme(e.target.value)}
          aria-label="テーマ" style={{ ...s.input, flex: 1 }}
        />
        <input
          type="text" value={content} placeholder="その日の内容 (任意)"
          onChange={(e) => setContent(e.target.value)}
          aria-label="その日の内容" style={{ ...s.input, flex: 2 }}
        />
        <button
          className="btn btn-primary btn-sm" disabled={busy} onClick={add}
        >
          {busy ? "保存中..." : "回を追加"}
        </button>
      </div>
    </section>
  );
}

const s: Record<string, CSSProperties> = {
  h: { margin: "0 0 0.5rem", fontSize: "1rem" },
  intro: {
    fontSize: "0.8rem", color: colors.textSecondary, margin: "0 0 0.75rem",
    lineHeight: 1.6,
  },
  list: { display: "grid", gap: "0.5rem", marginBottom: "0.75rem" },
  row: {
    display: "flex", alignItems: "center", gap: "0.5rem",
    padding: "0.5rem 0.75rem", border: `1px solid ${colors.border}`,
    borderRadius: "0.375rem", background: colors.background, fontSize: "0.875rem",
  },
  meta: { fontSize: "0.75rem", color: colors.textSecondary, minWidth: "6rem" },
  form: {
    display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center",
  },
  input: {
    padding: "0.375rem 0.5rem", border: `1px solid ${colors.border}`,
    borderRadius: "0.375rem", fontSize: "0.875rem",
  },
  empty: {
    padding: "0.75rem", textAlign: "center", color: colors.textSecondary,
    border: `1px dashed ${colors.borderStrong}`, borderRadius: "0.375rem",
    fontSize: "0.875rem",
  },
  hint: { padding: "1rem", color: colors.textSecondary, textAlign: "center" },
  error: {
    padding: "0.75rem", color: colors.danger, background: colors.dangerSubtle,
    borderRadius: "0.25rem", fontSize: "0.875rem", marginBottom: "0.75rem",
  },
};
