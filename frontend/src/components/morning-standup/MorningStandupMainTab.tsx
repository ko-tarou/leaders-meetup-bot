import {
  useCallback, useEffect, useMemo, useState,
  type CSSProperties, type ReactNode,
} from "react";
import type { EventAction } from "../../types";
import { request } from "../../api/client";
import { colors } from "../../styles/tokens";
import { MorningSessionsSection } from "./MorningSessionsSection";

// 003 朝勉強会けじめ制度 PR10: morning_standup action のメインタブ。
// 上部: 今日 (or 指定日) の出席状況テーブル + 手動 attend / 取消ボタン。
// 中部: 過去 N 日 (default 7) の出席率テーブル。
//
// 同型 KejimeAdminTab.tsx の Section / row パターンを踏襲。
// 操作後は両セクションを再 fetch (簡潔性優先、過剰最適化は避ける)。

type DateMember = {
  slackUserId: string;
  displayName: string;
  status: "attended" | "late" | null;
  attendanceId?: string;
};
type DateResp = { date: string; members: DateMember[] };

type StatsMember = {
  slackUserId: string;
  displayName: string;
  attendedCount: number;
  lateCount: number;
  attendanceRate: number;
};
type StatsResp = { from: string; to: string; days: number; members: StatsMember[] };

function todayJst(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function statusLabel(status: DateMember["status"]): { text: string; color: string } {
  switch (status) {
    case "attended": return { text: "✅ 出席済", color: colors.success };
    case "late": return { text: "❌ 未出席", color: colors.danger };
    case null: default: return { text: "⏳ 判定前", color: colors.textSecondary };
  }
}

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

export function MorningStandupMainTab({ eventId, actionId, action }: {
  eventId: string; actionId: string; action: EventAction;
}) {
  void action; // action prop は将来の拡張用 (例: 設定済みロール名表示)。
  const base = `/orgs/${eventId}/actions/${actionId}/morning-attendance`;
  const [date, setDate] = useState<string>(todayJst);
  const [day, setDay] = useState<DateResp | null>(null);
  const [stats, setStats] = useState<StatsResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [d, s2] = await Promise.all([
        request<DateResp>(`${base}?date=${encodeURIComponent(date)}`),
        request<StatsResp>(`${base}/stats?days=7`),
      ]);
      setDay(d); setStats(s2);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed");
    }
  }, [base, date]);
  useEffect(() => { void load(); }, [load]);

  async function attend(slackUserId: string, displayName: string) {
    if (!confirm(`${displayName} を ${date} の出席に登録します。よろしいですか？\n(既存 late があれば取り消されます)`)) return;
    setBusy(`a-${slackUserId}`);
    try {
      await request(`${base}`, {
        method: "POST",
        body: JSON.stringify({ date, slackUserId }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "attend failed");
    } finally { setBusy(null); }
  }

  async function markLate(slackUserId: string, displayName: string) {
    if (!confirm(`${displayName} を ${date} の欠席 (未出席) に変更します。よろしいですか？\n(遅刻イベントと未抽選ガチャが作られます)`)) return;
    setBusy(`l-${slackUserId}`);
    try {
      await request(`${base}`, {
        method: "POST",
        body: JSON.stringify({ date, slackUserId, status: "late" }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "mark late failed");
    } finally { setBusy(null); }
  }

  async function revoke(attendanceId: string, displayName: string) {
    if (!confirm(`${displayName} の ${date} の出席記録を削除します。\n(late への自動復活はしません)`)) return;
    setBusy(`d-${attendanceId}`);
    try {
      await request(`${base}/${attendanceId}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "revoke failed");
    } finally { setBusy(null); }
  }

  const sortedStats = useMemo(
    () => stats?.members.slice().sort((a, b) => b.attendanceRate - a.attendanceRate) ?? [],
    [stats],
  );

  if (day === null || stats === null) {
    return <div style={s.hint}>読み込み中...</div>;
  }

  return (
    <div style={{ display: "grid", gap: "1.5rem" }}>
      {error && <div style={s.error}>エラー: {error}</div>}

      <MorningSessionsSection eventId={eventId} actionId={actionId} />

      <section>
        <div style={s.dateRow}>
          <label htmlFor="ms-date" style={s.dateLabel}>📅 日付</label>
          <input
            id="ms-date" type="date" value={date}
            onChange={(e) => setDate(e.target.value)}
            max={todayJst()}
            style={s.dateInput}
          />
        </div>

        <Section
          title={`今日の出席状況 (${day.members.length}名)`}
          empty="ロール未設定またはメンバーが 0 名です。設定タブで「勉強会チーム」ロールを確認してください"
          isEmpty={day.members.length === 0}
        >
          {day.members.map((m) => {
            const lbl = statusLabel(m.status);
            const isAttended = m.status === "attended";
            return (
              <div key={m.slackUserId} style={s.row}>
                <span style={{ flex: 1, fontWeight: 500 }}>{m.displayName}</span>
                <span style={{ ...s.meta, color: lbl.color, minWidth: "5rem" }}>
                  {lbl.text}
                </span>
                {isAttended && m.attendanceId ? (
                  <>
                    <button
                      className="btn btn-ghost btn-sm"
                      disabled={busy === `l-${m.slackUserId}`}
                      onClick={() => markLate(m.slackUserId, m.displayName)}
                      aria-label={`${m.displayName} を欠席にする`}
                    >
                      欠席にする
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      disabled={busy === `d-${m.attendanceId}`}
                      onClick={() => revoke(m.attendanceId!, m.displayName)}
                      aria-label={`${m.displayName} の出席を取り消し`}
                    >
                      取り消し
                    </button>
                  </>
                ) : (
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={busy === `a-${m.slackUserId}`}
                    onClick={() => attend(m.slackUserId, m.displayName)}
                    aria-label={`${m.displayName} を出席にする`}
                  >
                    出席にする
                  </button>
                )}
              </div>
            );
          })}
        </Section>
      </section>

      <Section
        title={`過去 ${stats.days} 日の出席率 (${stats.from} 〜 ${stats.to})`}
        empty="集計データなし"
        isEmpty={sortedStats.length === 0}
      >
        {sortedStats.map((m) => (
          <div key={m.slackUserId} style={s.row}>
            <span style={{ flex: 1, fontWeight: 500 }}>{m.displayName}</span>
            <span style={s.meta}>
              出席 {m.attendedCount} / 遅刻 {m.lateCount}
            </span>
            <span style={{ ...s.rate, color: rateColor(m.attendanceRate) }}>
              {m.attendanceRate}%
            </span>
          </div>
        ))}
      </Section>
    </div>
  );
}

function rateColor(rate: number): string {
  if (rate >= 80) return colors.success;
  if (rate >= 50) return colors.warning;
  return colors.danger;
}

const s: Record<string, CSSProperties> = {
  h: { margin: "0 0 0.5rem", fontSize: "1rem" },
  list: { display: "grid", gap: "0.5rem" },
  row: {
    display: "flex", alignItems: "center", gap: "0.5rem",
    padding: "0.5rem 0.75rem", border: `1px solid ${colors.border}`,
    borderRadius: "0.375rem", background: colors.background, fontSize: "0.875rem",
  },
  meta: { fontSize: "0.75rem", color: colors.textSecondary },
  rate: { fontSize: "0.875rem", fontWeight: 600, minWidth: "3rem", textAlign: "right" },
  empty: {
    padding: "0.75rem", textAlign: "center", color: colors.textSecondary,
    border: `1px dashed ${colors.borderStrong}`, borderRadius: "0.375rem",
    fontSize: "0.875rem",
  },
  hint: { padding: "1rem", color: colors.textSecondary, textAlign: "center" },
  error: {
    padding: "0.75rem", color: colors.danger, background: colors.dangerSubtle,
    borderRadius: "0.25rem", fontSize: "0.875rem",
  },
  dateRow: {
    display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.75rem",
  },
  dateLabel: { fontSize: "0.875rem", color: colors.text },
  dateInput: {
    padding: "0.25rem 0.5rem", border: `1px solid ${colors.border}`,
    borderRadius: "0.375rem", fontSize: "0.875rem",
  },
};
