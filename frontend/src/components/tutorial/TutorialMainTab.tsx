import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import type { EventAction, SlackUser } from "../../types";
import { api } from "../../api";
import { request } from "../../api/client";
import { useToast } from "../ui/Toast";
import { colors } from "../../styles/tokens";

// 宗教イベント tutorial PR2/PR4: 参加時オンボーディング投稿のメインタブ。
// 上部: 現在の設定サマリ (トリガーチャンネル NAME / 送信方法)。生 ID は出さない。
// 中部: メンバー送信状況テーブル (GET .../tutorial/members)。名前のみ表示。
//   手動送信成功後に再フェッチして ✅/⚪ を最新化する。
// 下部: ユーザーを選んでチュートリアルを「手動送信」(テスト / 再送用)。
//   POST /orgs/:eventId/actions/:actionId/tutorial/send  body { userId }
//   not_configured (workspace 未設定 等) は分かりやすい案内に変換する。

type DeliveryMode = "dm" | "channel";

type Config = {
  workspaceId?: string | null;
  triggerChannelId?: string | null;
  deliveryMode?: DeliveryMode;
};

// GET .../tutorial/members の 1 行 (backend src/routes/api/tutorial.ts と一致)。
type TutorialMember = {
  userId: string;
  name: string;
  sent: boolean;
  sentAt: string | null;
};

/** ISO 文字列を "YYYY-MM-DD HH:mm" に整形する (秒以下は捨てる)。 */
function fmt(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

function parseConfig(raw: string | null | undefined): Config {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? (o as Config) : {};
  } catch {
    return {};
  }
}

export function TutorialMainTab({
  eventId,
  actionId,
  action,
}: {
  eventId: string;
  actionId: string;
  action: EventAction;
}) {
  const toast = useToast();
  const cfg = useMemo(() => parseConfig(action.config), [action.config]);
  const workspaceId = cfg.workspaceId ?? "";

  const [members, setMembers] = useState<SlackUser[] | null>(null);
  const [channelName, setChannelName] = useState<string>("");
  const [userId, setUserId] = useState<string>("");
  const [sending, setSending] = useState(false);

  // 送信状況テーブル: GET .../tutorial/members。loading=null / error=string。
  const [status, setStatus] = useState<TutorialMember[] | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const deliveryLabel = cfg.deliveryMode === "channel" ? "チャンネルへ投稿" : "本人へDM";

  // メンバー送信状況を取得する (mount 時 + 手動送信成功後に再実行)。
  // workspace 未設定なら backend は [] を返す (空状態として案内)。4xx は
  // クラッシュさせず分かりやすいメッセージに変換する。
  const loadStatus = useCallback(async () => {
    setStatusError(null);
    try {
      const list = await request<TutorialMember[]>(
        `/orgs/${eventId}/actions/${actionId}/tutorial/members`,
      );
      setStatus(Array.isArray(list) ? list : []);
    } catch {
      setStatus([]);
      setStatusError("メンバー一覧を取得できませんでした。設定を確認してください。");
    }
  }, [eventId, actionId]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // workspaceId が設定済みのとき: メンバー一覧 + トリガーチャンネル名を解決する。
  useEffect(() => {
    if (!workspaceId) {
      setMembers(null);
      return;
    }
    let cancelled = false;
    api.workspaces
      .members(workspaceId)
      .then((list) => {
        if (!cancelled) setMembers(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (!cancelled) setMembers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  useEffect(() => {
    const cid = cfg.triggerChannelId;
    if (!workspaceId || !cid) {
      setChannelName("");
      return;
    }
    let cancelled = false;
    api
      .getSlackChannels(workspaceId)
      .then((list) => {
        if (cancelled) return;
        const hit = (Array.isArray(list) ? list : []).find((ch) => ch.id === cid);
        setChannelName(hit ? hit.name : "");
      })
      .catch(() => {
        if (!cancelled) setChannelName("");
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, cfg.triggerChannelId]);

  async function send() {
    if (!userId) return;
    setSending(true);
    try {
      await request(`/orgs/${eventId}/actions/${actionId}/tutorial/send`, {
        method: "POST",
        body: JSON.stringify({ userId }),
      });
      toast.success("送信しました");
      // 送信状況テーブルを再フェッチして送信済みに反映する。
      await loadStatus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("not_configured")) {
        toast.error("先に設定を保存してください");
      } else {
        toast.error(msg || "送信に失敗しました");
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: "1.5rem" }}>
      <section>
        <h3 style={s.h}>現在の設定</h3>
        <div style={s.list}>
          <div style={s.row}>
            <span style={s.label}>📥 トリガー</span>
            <span style={{ flex: 1 }}>
              {cfg.triggerChannelId
                ? channelName
                  ? `#${channelName}`
                  : "(設定済み)"
                : "未設定"}
            </span>
          </div>
          <div style={s.row}>
            <span style={s.label}>📤 送信方法</span>
            <span style={{ flex: 1 }}>{deliveryLabel}</span>
          </div>
        </div>
        <p style={s.helper}>
          新メンバーがトリガーチャンネルに参加すると自動送信されます。下は手動テスト/再送用です。
        </p>
      </section>

      <section>
        <h3 style={s.h}>
          メンバー送信状況{status ? ` (${status.length})` : ""}
        </h3>
        {statusError && <div style={s.warn}>{statusError}</div>}
        {status === null ? (
          <div style={s.hint}>読み込み中...</div>
        ) : status.length === 0 ? (
          <div style={s.empty}>メンバーがいません / ワークスペース未設定</div>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>名前</th>
                <th style={s.th}>送信状況</th>
              </tr>
            </thead>
            <tbody>
              {status.map((m) => (
                <tr key={m.userId}>
                  <td style={s.td}>{m.name}</td>
                  <td style={s.td}>
                    {m.sent
                      ? `✅ 送信済み${m.sentAt ? ` (${fmt(m.sentAt)})` : ""}`
                      : "⚪ 未送信"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h3 style={s.h}>手動送信 (テスト)</h3>
        {!workspaceId ? (
          <div style={s.warn}>
            ワークスペースが未設定です。「設定」タブで保存してください。
          </div>
        ) : (
          <div style={s.sendRow}>
            <select
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              disabled={sending || members === null}
              aria-label="送信先ユーザー"
              style={s.select}
            >
              <option value="">
                {members === null ? "取得中..." : "ユーザーを選択"}
              </option>
              {(members ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName || m.realName || m.name}
                </option>
              ))}
            </select>
            <button
              className="btn btn-primary btn-sm"
              disabled={sending || !userId}
              onClick={() => void send()}
            >
              {sending ? "送信中..." : "このユーザーに送信"}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  h: { margin: "0 0 0.5rem", fontSize: "1rem" },
  list: { display: "grid", gap: "0.5rem" },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    padding: "0.5rem 0.75rem",
    border: `1px solid ${colors.border}`,
    borderRadius: "0.375rem",
    background: colors.background,
    fontSize: "0.875rem",
  },
  label: { minWidth: "6rem", color: colors.textSecondary, fontSize: "0.8rem" },
  helper: { margin: "0.5rem 0 0", fontSize: "0.75rem", color: colors.textSecondary },
  hint: { padding: "1rem", color: colors.textSecondary, textAlign: "center", fontSize: "0.875rem" },
  empty: {
    padding: "0.75rem",
    textAlign: "center",
    color: colors.textSecondary,
    border: `1px dashed ${colors.borderStrong}`,
    borderRadius: "0.375rem",
    fontSize: "0.875rem",
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: "0.875rem",
    border: `1px solid ${colors.border}`,
    borderRadius: "0.375rem",
    overflow: "hidden",
  },
  th: {
    textAlign: "left",
    padding: "0.5rem 0.75rem",
    background: colors.background,
    color: colors.textSecondary,
    fontSize: "0.8rem",
    borderBottom: `1px solid ${colors.border}`,
  },
  td: {
    padding: "0.5rem 0.75rem",
    borderBottom: `1px solid ${colors.border}`,
  },
  sendRow: { display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "center" },
  select: {
    minWidth: "14rem",
    padding: "0.5rem",
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: "0.25rem",
    background: colors.background,
    color: colors.text,
    fontSize: "0.875rem",
  },
  warn: {
    padding: "0.5rem 0.75rem",
    color: colors.warning,
    background: colors.warningSubtle,
    borderRadius: "0.25rem",
    fontSize: "0.8rem",
  },
};
