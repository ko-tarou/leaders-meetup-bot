import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import type { EventAction } from "../../types";
import { request } from "../../api/client";
import { api } from "../../api";
import { useToast } from "../ui/Toast";
import { colors } from "../../styles/tokens";

// ADR-0011: channel_router メインタブ。
// 1. workspace 設定 (未設定なら picker を出す)
// 2. 未振り分けメンバー一覧 (手動同期 users.list / 無視の切替)
// 3. ドライラン (振り分け計画の表示のみ・実招待はしない)
// 実招待ボタンは次フェーズまで disabled (coming soon)。

type Config = { workspaceId?: string | null };

type Member = {
  id: string;
  slackUserId: string;
  displayName: string | null;
  status: "pending" | "ignored" | "routed";
  firstSeenAt: string;
};

type PlanEntry = {
  slackUserId: string;
  displayName: string | null;
  kind: "operator" | "participant";
  roleNames: string[];
  channels: Array<{ channelId: string; channelName: string | null }>;
  reason: "matched" | "no_rule_for_role" | "no_participant_rule";
};

function parseConfig(raw: string | null | undefined): Config {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? (o as Config) : {};
  } catch {
    return {};
  }
}

const STATUS_LABEL: Record<Member["status"], string> = {
  pending: "未振り分け",
  ignored: "対象外",
  routed: "振り分け済み",
};

const REASON_LABEL: Record<PlanEntry["reason"], string> = {
  matched: "OK",
  no_rule_for_role: "ロールに対応するルールがありません",
  no_participant_rule: "参加者向けルールがありません",
};

export function ChannelRouterMainTab({
  eventId,
  action,
  onChanged,
}: {
  eventId: string;
  action: EventAction;
  onChanged: () => void;
}) {
  const toast = useToast();
  const cfg = useMemo(() => parseConfig(action.config), [action.config]);
  const base = `/orgs/${eventId}/actions/${action.id}/channel-router`;

  const [members, setMembers] = useState<Member[]>([]);
  const [plan, setPlan] = useState<PlanEntry[] | null>(null);
  const [busy, setBusy] = useState<"sync" | "dryrun" | "save" | null>(null);

  // workspace picker (未設定時のみ)
  const [wsList, setWsList] = useState<Array<{ id: string; name: string }>>([]);
  const [wsSelect, setWsSelect] = useState("");
  const wsName = wsList.find((w) => w.id === cfg.workspaceId)?.name;

  const loadMembers = useCallback(async () => {
    try {
      const res = await request<{ members: Member[] }>(`${base}/members`);
      setMembers(res.members);
    } catch {
      // 初回 (テーブル空) でも 200 が返る想定。失敗は黙って空のまま
    }
  }, [base]);

  useEffect(() => {
    loadMembers();
    api.workspaces
      .list()
      .then((ws) => setWsList(ws.map((w) => ({ id: w.id, name: w.name }))))
      .catch(() => setWsList([]));
  }, [loadMembers]);

  async function saveWorkspace() {
    if (!wsSelect) return;
    setBusy("save");
    try {
      await api.events.actions.update(eventId, action.id, {
        config: JSON.stringify({ ...cfg, workspaceId: wsSelect }),
      });
      toast.success("ワークスペースを設定しました");
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setBusy(null);
    }
  }

  async function sync() {
    setBusy("sync");
    try {
      const res = await request<{ fetched: number; added: number }>(
        `${base}/sync`,
        { method: "POST" },
      );
      toast.success(`同期しました (メンバー ${res.fetched} 名 / 新規 ${res.added} 名)`);
      await loadMembers();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (msg.includes("not_configured")) {
        toast.error("先にワークスペースを設定してください");
      } else {
        toast.error(msg || "同期に失敗しました");
      }
    } finally {
      setBusy(null);
    }
  }

  async function dryRun() {
    setBusy("dryrun");
    try {
      const res = await request<{ plan: PlanEntry[] }>(`${base}/dry-run`, {
        method: "POST",
      });
      setPlan(res.plan);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "ドライランに失敗しました");
    } finally {
      setBusy(null);
    }
  }

  async function toggleIgnore(m: Member) {
    const next = m.status === "ignored" ? "pending" : "ignored";
    try {
      await request(`${base}/members/${m.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: next }),
      });
      await loadMembers();
      setPlan(null); // 対象が変わったので古い計画は破棄
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "更新に失敗しました");
    }
  }

  const pendingCount = members.filter((m) => m.status === "pending").length;

  return (
    <div style={{ display: "grid", gap: "1.5rem" }}>
      {/* 1. workspace 設定 */}
      <section>
        <h3 style={s.h}>Slack ワークスペース</h3>
        {cfg.workspaceId ? (
          <div style={s.note}>
            🔗 {wsName ?? cfg.workspaceId} に接続します（メンバー取得は読み取りのみ）
          </div>
        ) : (
          <div style={s.warn}>
            <div style={{ marginBottom: "0.5rem" }}>
              振り分け対象の Slack ワークスペースが未設定です。
            </div>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <select
                value={wsSelect}
                onChange={(e) => setWsSelect(e.target.value)}
                style={s.select}
              >
                <option value="">選択してください</option>
                {wsList.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
              <button
                onClick={saveWorkspace}
                disabled={!wsSelect || busy === "save"}
                style={s.primaryBtn}
              >
                保存
              </button>
            </div>
          </div>
        )}
      </section>

      {/* 2. 未振り分けメンバー */}
      <section>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <h3 style={{ ...s.h, margin: 0 }}>
            未振り分けメンバー ({pendingCount}名)
          </h3>
          <button
            onClick={sync}
            disabled={busy === "sync" || !cfg.workspaceId}
            style={{ ...s.secondaryBtn, marginLeft: "auto" }}
          >
            {busy === "sync" ? "同期中..." : "メンバーを同期"}
          </button>
        </div>
        <p style={s.hint}>
          「メンバーを同期」でワークスペースの全メンバーを取得し、新しく見つかった人を
          未振り分けとして検出します（Slack への書き込みは行いません）。
        </p>
        {members.length === 0 ? (
          <div style={s.empty}>
            まだメンバーを検出していません。「メンバーを同期」を押してください。
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>メンバー</th>
                  <th style={s.th}>Slack ID</th>
                  <th style={s.th}>状態</th>
                  <th style={s.th}></th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id}>
                    <td style={s.td}>{m.displayName ?? "(名前なし)"}</td>
                    <td style={{ ...s.td, fontFamily: "monospace" }}>
                      {m.slackUserId}
                    </td>
                    <td style={s.td}>
                      <span
                        style={{
                          ...s.chip,
                          background:
                            m.status === "pending"
                              ? colors.warningSubtle
                              : colors.surface,
                        }}
                      >
                        {STATUS_LABEL[m.status]}
                      </span>
                    </td>
                    <td style={s.td}>
                      {m.status !== "routed" && (
                        <button
                          onClick={() => toggleIgnore(m)}
                          style={s.linkBtn}
                        >
                          {m.status === "ignored" ? "対象に戻す" : "対象外にする"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 3. ドライラン */}
      <section>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <h3 style={{ ...s.h, margin: 0 }}>ドライラン</h3>
          <button
            onClick={dryRun}
            disabled={busy === "dryrun"}
            style={{ ...s.primaryBtn, marginLeft: "auto" }}
          >
            {busy === "dryrun" ? "計算中..." : "ドライランを実行"}
          </button>
        </div>
        <p style={s.hint}>
          未振り分けメンバーを「運営名簿にいる → ロールのルール / いない → 参加者ルール」で
          判定し、招待予定チャンネルを表示します。実際の招待は行いません。
        </p>
        {plan && plan.length === 0 && (
          <div style={s.empty}>未振り分けメンバーがいないため、計画は空です。</div>
        )}
        {plan && plan.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>メンバー</th>
                  <th style={s.th}>判定</th>
                  <th style={s.th}>招待予定チャンネル</th>
                  <th style={s.th}>備考</th>
                </tr>
              </thead>
              <tbody>
                {plan.map((p) => (
                  <tr key={p.slackUserId}>
                    <td style={s.td}>
                      {p.displayName ?? p.slackUserId}
                    </td>
                    <td style={s.td}>
                      {p.kind === "operator"
                        ? `🛡 運営${p.roleNames.length > 0 ? ` (${p.roleNames.join(", ")})` : ""}`
                        : "🙋 参加者"}
                    </td>
                    <td style={s.td}>
                      {p.channels.length > 0
                        ? p.channels
                            .map((ch) => `#${ch.channelName ?? ch.channelId}`)
                            .join(", ")
                        : "-"}
                    </td>
                    <td style={{ ...s.td, color: p.reason === "matched" ? colors.textMuted : colors.danger }}>
                      {REASON_LABEL[p.reason]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ marginTop: "1rem" }}>
          <button disabled style={s.disabledBtn} title="実際の招待は次フェーズで有効になります">
            招待を実行 (coming soon)
          </button>
          <p style={s.hint}>
            実際に Slack へ招待する機能は次フェーズで有効化されます。現在はドライランのみです。
          </p>
        </div>
      </section>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  h: { fontSize: "1rem", margin: "0 0 0.5rem" },
  hint: { fontSize: "0.8rem", color: colors.textMuted, margin: "0.5rem 0" },
  note: {
    fontSize: "0.85rem",
    color: colors.textMuted,
    padding: "0.5rem 0.75rem",
    background: colors.surface,
    borderRadius: 8,
  },
  warn: {
    fontSize: "0.85rem",
    padding: "0.75rem",
    background: colors.warningSubtle,
    borderRadius: 8,
  },
  empty: {
    padding: "1rem",
    fontSize: "0.85rem",
    color: colors.textMuted,
    background: colors.surface,
    borderRadius: 8,
  },
  table: { width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" },
  th: {
    textAlign: "left",
    padding: "0.5rem",
    borderBottom: `2px solid ${colors.border}`,
    color: colors.textMuted,
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  td: {
    padding: "0.5rem",
    borderBottom: `1px solid ${colors.border}`,
    verticalAlign: "top",
  },
  chip: {
    display: "inline-block",
    padding: "0.1rem 0.5rem",
    borderRadius: 999,
    fontSize: "0.75rem",
  },
  select: {
    padding: "0.4rem 0.5rem",
    borderRadius: 6,
    border: `1px solid ${colors.border}`,
    minWidth: 220,
  },
  primaryBtn: {
    padding: "0.4rem 0.9rem",
    borderRadius: 6,
    border: "none",
    background: colors.primary,
    color: colors.textInverse,
    cursor: "pointer",
    fontSize: "0.85rem",
  },
  secondaryBtn: {
    padding: "0.4rem 0.9rem",
    borderRadius: 6,
    border: `1px solid ${colors.border}`,
    background: "transparent",
    cursor: "pointer",
    fontSize: "0.85rem",
  },
  disabledBtn: {
    padding: "0.4rem 0.9rem",
    borderRadius: 6,
    border: `1px solid ${colors.border}`,
    background: colors.surface,
    color: colors.textMuted,
    cursor: "not-allowed",
    fontSize: "0.85rem",
  },
  linkBtn: {
    border: "none",
    background: "transparent",
    color: colors.primary,
    cursor: "pointer",
    fontSize: "0.8rem",
    padding: 0,
  },
};
