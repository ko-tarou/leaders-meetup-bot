import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import type { EventAction } from "../../types";
import { request } from "../../api/client";
import { api } from "../../api";
import { useToast } from "../ui/Toast";
import { colors } from "../../styles/tokens";

// ADR-0011: channel_router「振り分けルール」タブ。
// 「対象 (運営ロール or 参加者) -> チャンネル」のマッピングを編集する。
// - 対象: 同一イベントの role_management のロール一覧 + 「参加者 (名簿にいない人)」
// - チャンネル: workspace のチャンネル一覧から選択。一覧が取れない環境
//   (トークン未設定など) では ID + 名前の手入力にフォールバックする。

type Rule = {
  id: string;
  targetKind: "role" | "participant";
  roleId: string | null;
  roleName: string | null;
  channelId: string;
  channelName: string | null;
};

type Role = { id: string; name: string };
type Channel = { id: string; name: string };

const PARTICIPANT = "__participant__";

function parseWorkspaceId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as { workspaceId?: unknown };
    return typeof o?.workspaceId === "string" && o.workspaceId !== ""
      ? o.workspaceId
      : null;
  } catch {
    return null;
  }
}

export function ChannelRouterRulesTab({
  eventId,
  action,
}: {
  eventId: string;
  action: EventAction;
}) {
  const toast = useToast();
  const base = `/orgs/${eventId}/actions/${action.id}/channel-router`;
  const workspaceId = useMemo(
    () => parseWorkspaceId(action.config),
    [action.config],
  );

  const [rules, setRules] = useState<Rule[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [channels, setChannels] = useState<Channel[] | null>(null); // null = 取得失敗 -> 手入力
  const [busy, setBusy] = useState(false);

  // 追加フォーム
  const [target, setTarget] = useState<string>(PARTICIPANT);
  const [channelSelect, setChannelSelect] = useState("");
  const [manualChannelId, setManualChannelId] = useState("");
  const [manualChannelName, setManualChannelName] = useState("");

  const loadRules = useCallback(async () => {
    try {
      const res = await request<{ rules: Rule[] }>(`${base}/rules`);
      setRules(res.rules);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "ルールの取得に失敗しました");
    }
    // toast は安定参照でない可能性があるため依存に含めない (mount 系のみで呼ぶ)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  useEffect(() => {
    loadRules();
    request<{ roles: Role[] }>(`${base}/roles`)
      .then((res) => setRoles(res.roles))
      .catch(() => setRoles([]));
    if (workspaceId) {
      api
        .getSlackChannels(workspaceId)
        .then((chs) => setChannels(chs))
        .catch(() => setChannels(null));
    } else {
      setChannels(null);
    }
  }, [base, workspaceId, loadRules]);

  async function addRule() {
    const useManual = channels === null;
    const channelId = useManual ? manualChannelId.trim() : channelSelect;
    const channelName = useManual
      ? manualChannelName.trim()
      : (channels?.find((ch) => ch.id === channelSelect)?.name ?? "");
    if (!channelId) {
      toast.error("チャンネルを指定してください");
      return;
    }
    setBusy(true);
    try {
      await request(`${base}/rules`, {
        method: "POST",
        body: JSON.stringify({
          targetKind: target === PARTICIPANT ? "participant" : "role",
          roleId: target === PARTICIPANT ? undefined : target,
          channelId,
          channelName: channelName || undefined,
        }),
      });
      toast.success("ルールを追加しました");
      setChannelSelect("");
      setManualChannelId("");
      setManualChannelName("");
      await loadRules();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (msg.includes("already exists")) {
        toast.error("同じルールが既に登録されています");
      } else {
        toast.error(msg || "追加に失敗しました");
      }
    } finally {
      setBusy(false);
    }
  }

  async function removeRule(rule: Rule) {
    try {
      await request(`${base}/rules/${rule.id}`, { method: "DELETE" });
      await loadRules();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "削除に失敗しました");
    }
  }

  function targetLabel(r: Rule): string {
    if (r.targetKind === "participant") return "🙋 参加者 (名簿にいない人)";
    return `🛡 ${r.roleName ?? "(削除済みロール)"}`;
  }

  return (
    <div style={{ display: "grid", gap: "1.5rem" }}>
      <section>
        <h3 style={s.h}>振り分けルール ({rules.length}件)</h3>
        <p style={s.hint}>
          「この対象が入ってきたら、このチャンネルへ招待する」の対応表です。
          運営はロールごと、名簿にいない人は「参加者」ルールが適用されます。
        </p>
        {rules.length === 0 ? (
          <div style={s.empty}>ルールがまだありません。下のフォームから追加してください。</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>対象</th>
                  <th style={s.th}>チャンネル</th>
                  <th style={s.th}></th>
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.id}>
                    <td style={s.td}>{targetLabel(r)}</td>
                    <td style={s.td}>
                      #{r.channelName ?? r.channelId}
                      <span style={s.mono}> ({r.channelId})</span>
                    </td>
                    <td style={s.td}>
                      <button onClick={() => removeRule(r)} style={s.dangerLink}>
                        削除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h3 style={s.h}>ルールを追加</h3>
        <div style={s.formRow}>
          <label style={s.label}>
            対象
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              style={s.select}
            >
              <option value={PARTICIPANT}>🙋 参加者 (名簿にいない人)</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  🛡 {r.name}
                </option>
              ))}
            </select>
          </label>
          {channels !== null ? (
            <label style={s.label}>
              チャンネル
              <select
                value={channelSelect}
                onChange={(e) => setChannelSelect(e.target.value)}
                style={s.select}
              >
                <option value="">選択してください</option>
                {channels.map((ch) => (
                  <option key={ch.id} value={ch.id}>
                    #{ch.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <>
              <label style={s.label}>
                チャンネル ID
                <input
                  value={manualChannelId}
                  onChange={(e) => setManualChannelId(e.target.value)}
                  placeholder="C0123456789"
                  style={s.input}
                />
              </label>
              <label style={s.label}>
                チャンネル名 (任意)
                <input
                  value={manualChannelName}
                  onChange={(e) => setManualChannelName(e.target.value)}
                  placeholder="general"
                  style={s.input}
                />
              </label>
            </>
          )}
          <button onClick={addRule} disabled={busy} style={s.primaryBtn}>
            追加
          </button>
        </div>
        {channels === null && (
          <p style={s.hint}>
            チャンネル一覧を取得できなかったため手入力モードです。Slack のチャンネル詳細から
            ID (C から始まる文字列) をコピーして貼り付けてください。
          </p>
        )}
        {roles.length === 0 && (
          <p style={s.hint}>
            運営ロールが見つかりません。ロール別の振り分けを使うには、このイベントの
            「メンバー」タブでロール管理 (運営名簿) を設定してください。
          </p>
        )}
      </section>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  h: { fontSize: "1rem", margin: "0 0 0.5rem" },
  hint: { fontSize: "0.8rem", color: colors.textMuted, margin: "0.5rem 0" },
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
  mono: {
    fontFamily: "monospace",
    fontSize: "0.75rem",
    color: colors.textMuted,
  },
  formRow: {
    display: "flex",
    gap: "0.75rem",
    alignItems: "flex-end",
    flexWrap: "wrap",
  },
  label: {
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
    fontSize: "0.8rem",
    color: colors.textSecondary,
  },
  select: {
    padding: "0.4rem 0.5rem",
    borderRadius: 6,
    border: `1px solid ${colors.border}`,
    minWidth: 200,
  },
  input: {
    padding: "0.4rem 0.5rem",
    borderRadius: 6,
    border: `1px solid ${colors.border}`,
    minWidth: 160,
  },
  primaryBtn: {
    padding: "0.45rem 1rem",
    borderRadius: 6,
    border: "none",
    background: colors.primary,
    color: colors.textInverse,
    cursor: "pointer",
    fontSize: "0.85rem",
  },
  dangerLink: {
    border: "none",
    background: "transparent",
    color: colors.danger,
    cursor: "pointer",
    fontSize: "0.8rem",
    padding: 0,
  },
};
