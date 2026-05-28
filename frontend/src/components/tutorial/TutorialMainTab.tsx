import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { EventAction, SlackUser } from "../../types";
import { api } from "../../api";
import { request } from "../../api/client";
import { useToast } from "../ui/Toast";
import { colors } from "../../styles/tokens";

// 宗教イベント tutorial PR2: 参加時オンボーディング投稿のメインタブ。
// 上部: 現在の設定サマリ (トリガーチャンネル NAME / 送信方法)。生 ID は出さない。
// 下部: ユーザーを選んでチュートリアルを「手動送信」(テスト / 再送用)。
//   POST /orgs/:eventId/actions/:actionId/tutorial/send  body { userId }
//   not_configured (workspace 未設定 等) は分かりやすい案内に変換する。

type DeliveryMode = "dm" | "channel";

type Config = {
  workspaceId?: string | null;
  triggerChannelId?: string | null;
  deliveryMode?: DeliveryMode;
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

  const deliveryLabel = cfg.deliveryMode === "channel" ? "チャンネルへ投稿" : "本人へDM";

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
