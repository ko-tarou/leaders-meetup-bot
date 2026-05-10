import { useState, type CSSProperties } from "react";
import type {
  ChannelDiff,
  EventAction,
  SyncDiffResponse,
  SyncResult,
} from "../../types";
import { api } from "../../api";
import { useToast } from "../ui/Toast";
import { useConfirm } from "../ui/ConfirmDialog";
import { colors } from "../../styles/tokens";

// Sprint 24 / role_management:
// 「同期」タブ。
// - 「diff を取得」ボタンで sync-diff を呼び、各 channel の toInvite/toKick を表示
// - 「同期実行」ボタンで sync を呼び、invite/kick を実行
// - エラー時は scope 不足 / bot 未参加 などのヒントを併記
//
// 確認ダイアログを必ず挟む (kick が破壊的操作のため)。

type Config = { workspaceId?: string };

function parseConfig(raw: string): Config {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

type Props = {
  eventId: string;
  action: EventAction;
};

export function RoleSyncTab({ eventId, action }: Props) {
  const toast = useToast();
  const { confirm } = useConfirm();
  const cfg = parseConfig(action.config);
  const workspaceId = cfg.workspaceId;
  const [diff, setDiff] = useState<SyncDiffResponse | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [syncing, setSyncing] = useState(false);

  const totalInvite = diff?.channels.reduce(
    (acc, c) => acc + c.toInvite.length,
    0,
  );
  const totalKick = diff?.channels.reduce((acc, c) => acc + c.toKick.length, 0);

  const fetchDiff = async () => {
    setDiffLoading(true);
    setDiffError(null);
    setSyncResult(null);
    try {
      const res = await api.roles.syncDiff(eventId, action.id);
      setDiff(res);
    } catch (e) {
      setDiffError(
        e instanceof Error ? e.message : "diff の取得に失敗しました",
      );
    } finally {
      setDiffLoading(false);
    }
  };

  const runSync = async () => {
    if (!diff) {
      toast.error("先に diff を取得してください");
      return;
    }
    const ok = await confirm({
      title: "同期実行",
      message: `${totalInvite ?? 0} 件の invite と ${totalKick ?? 0} 件の kick を実行します。よろしいですか？`,
      variant: "danger",
      confirmLabel: "実行",
    });
    if (!ok) return;
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await api.roles.sync(eventId, action.id);
      setSyncResult(res);
      if (res.errors.length === 0) {
        toast.success(
          `同期完了: invite ${res.invited} / kick ${res.kicked}`,
        );
      } else {
        toast.warning(
          `同期完了 (一部失敗): invite ${res.invited} / kick ${res.kicked} / errors ${res.errors.length}`,
        );
      }
      // 成功後 diff を再取得して空になったか確認できるようにする。
      try {
        const next = await api.roles.syncDiff(eventId, action.id);
        setDiff(next);
      } catch {
        /* noop: 失敗しても sync 自体は完了している */
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "同期に失敗しました");
    } finally {
      setSyncing(false);
    }
  };

  if (!workspaceId) {
    return (
      <div style={s.warn}>
        ワークスペースが未設定です。「その他設定」タブから登録してください。
      </div>
    );
  }

  return (
    <div>
      <p style={s.desc}>
        ロール × メンバー × チャンネル の対応関係から「各チャンネルに居るべき
        メンバー」を計算し、Slack 側の現状と diff を取って invite / kick で同期
        します。bot 自身は kick 対象から除外されます。
      </p>

      <div style={s.actionRow}>
        <button
          onClick={fetchDiff}
          disabled={diffLoading || syncing}
          style={s.secondaryBtn}
        >
          {diffLoading ? "取得中..." : "diff を取得"}
        </button>
        <button
          onClick={runSync}
          disabled={!diff || syncing || diffLoading}
          style={s.primaryBtn}
        >
          {syncing ? "同期中..." : "同期実行"}
        </button>
      </div>

      {diffError && (
        <div style={s.error}>
          エラー: {diffError}
          <ScopeHint message={diffError} />
        </div>
      )}

      {diff && (
        <div style={{ marginTop: "1rem" }}>
          <div style={s.summary}>
            workspace: {diff.workspaceId} / 対象 {diff.channels.length} チャンネル
            {totalInvite !== undefined && (
              <>
                {" "}
                / 招待 {totalInvite} 件 / 退出 {totalKick} 件
              </>
            )}
          </div>

          {diff.channels.length === 0 ? (
            <div style={s.empty}>
              管理対象のチャンネルがありません。「ロール」タブから各ロールに
              チャンネルを割当ててください。
            </div>
          ) : (
            <div style={{ display: "grid", gap: "0.5rem" }}>
              {diff.channels.map((c) => (
                <ChannelDiffRow key={c.channelId} diff={c} />
              ))}
            </div>
          )}
        </div>
      )}

      {syncResult && (
        <div style={{ marginTop: "1.5rem" }}>
          <h3 style={s.heading}>同期結果</h3>
          <div style={s.resultBox}>
            <div>
              <strong>invite:</strong> {syncResult.invited} 件
            </div>
            <div>
              <strong>kick:</strong> {syncResult.kicked} 件
            </div>
            <div>
              <strong>errors:</strong> {syncResult.errors.length} 件
            </div>
          </div>
          {syncResult.errors.length > 0 && (
            <div style={{ marginTop: "0.5rem" }}>
              <h4 style={s.subHeading}>エラー詳細</h4>
              <div style={{ display: "grid", gap: "0.25rem" }}>
                {syncResult.errors.map((err, i) => (
                  <div key={i} style={s.errorRow}>
                    <div>
                      <strong>[{err.action}]</strong> channel: {err.channelId}
                      {err.userId && ` / user: ${err.userId}`}
                      {err.users &&
                        err.users.length > 0 &&
                        ` / users: ${err.users.length} 件`}
                    </div>
                    <div style={s.errorMsg}>{err.error}</div>
                    <ScopeHint message={err.error} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ChannelDiffRow({ diff }: { diff: ChannelDiff }) {
  const noChange =
    !diff.error && diff.toInvite.length === 0 && diff.toKick.length === 0;
  return (
    <div style={s.diffRow}>
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem" }}>
        <strong>#{diff.channelName}</strong>
        <span style={s.metaInline}>{diff.channelId}</span>
        {noChange && <span style={s.okBadge}>変更なし</span>}
      </div>
      {diff.error && (
        <div style={{ ...s.error, marginTop: "0.5rem" }}>
          取得失敗: {diff.error}
        </div>
      )}
      {diff.toInvite.length > 0 && (
        <div style={s.diffSection}>
          <span style={s.inviteLabel}>+ invite ({diff.toInvite.length}):</span>{" "}
          <span style={s.diffUsers}>{diff.toInvite.join(", ")}</span>
        </div>
      )}
      {diff.toKick.length > 0 && (
        <div style={s.diffSection}>
          <span style={s.kickLabel}>− kick ({diff.toKick.length}):</span>{" "}
          <span style={s.diffUsers}>{diff.toKick.join(", ")}</span>
        </div>
      )}
    </div>
  );
}

// scope 不足 / bot 未参加 の error message を解析してヒントを表示する。
// Slack API のエラー文字列規約: "missing_scope", "not_in_channel" 等。
function ScopeHint({ message }: { message: string }) {
  const lower = message.toLowerCase();
  if (lower.includes("missing_scope")) {
    return (
      <div style={s.hint}>
        Slack App 設定で必要な scope (users:read / channels:manage /
        groups:write 等) を追加し、bot を再 install してください。
      </div>
    );
  }
  if (lower.includes("not_in_channel") || lower.includes("channel_not_found")) {
    return (
      <div style={s.hint}>
        bot が該当チャンネルに参加していません。Slack 上でチャンネルに bot を
        招待してから再実行してください。
      </div>
    );
  }
  if (lower.includes("cant_kick_self")) {
    return (
      <div style={s.hint}>
        bot 自身は kick できません (除外処理が効いているはずなので発生時は要報告)。
      </div>
    );
  }
  return null;
}

const s: Record<string, CSSProperties> = {
  desc: {
    color: colors.textSecondary,
    fontSize: "0.875rem",
    marginTop: 0,
  },
  warn: {
    padding: "1rem",
    color: colors.warning,
    background: colors.warningSubtle,
    borderRadius: "0.25rem",
    fontSize: "0.875rem",
  },
  actionRow: {
    display: "flex",
    gap: "0.5rem",
    marginBottom: "0.75rem",
  },
  primaryBtn: {
    background: colors.primary,
    color: colors.textInverse,
    border: "none",
    padding: "0.5rem 1rem",
    borderRadius: "0.25rem",
    cursor: "pointer",
  },
  secondaryBtn: {
    padding: "0.5rem 1rem",
    border: `1px solid ${colors.borderStrong}`,
    background: colors.background,
    borderRadius: "0.25rem",
    cursor: "pointer",
  },
  summary: {
    fontSize: "0.875rem",
    color: colors.textSecondary,
    marginBottom: "0.5rem",
  },
  empty: {
    padding: "1.5rem",
    textAlign: "center",
    color: colors.textSecondary,
    border: `1px dashed ${colors.borderStrong}`,
    borderRadius: "0.5rem",
    fontSize: "0.875rem",
  },
  diffRow: {
    padding: "0.75rem 1rem",
    border: `1px solid ${colors.border}`,
    borderRadius: "0.375rem",
    background: colors.background,
  },
  diffSection: {
    marginTop: "0.25rem",
    fontSize: "0.875rem",
  },
  diffUsers: {
    fontFamily: "monospace",
    fontSize: "0.75rem",
    color: colors.text,
    wordBreak: "break-all",
  },
  inviteLabel: {
    color: colors.success,
    fontWeight: 600,
  },
  kickLabel: {
    color: colors.danger,
    fontWeight: 600,
  },
  okBadge: {
    fontSize: "0.7rem",
    padding: "0.125rem 0.375rem",
    background: colors.successSubtle,
    color: colors.success,
    borderRadius: "0.25rem",
  },
  metaInline: {
    fontSize: "0.75rem",
    color: colors.textSecondary,
  },
  error: {
    padding: "0.75rem",
    color: colors.danger,
    background: colors.dangerSubtle,
    borderRadius: "0.25rem",
    fontSize: "0.875rem",
  },
  errorRow: {
    padding: "0.5rem 0.75rem",
    border: `1px solid ${colors.danger}`,
    borderRadius: "0.25rem",
    background: colors.background,
    fontSize: "0.8rem",
  },
  errorMsg: {
    fontFamily: "monospace",
    fontSize: "0.75rem",
    color: colors.danger,
    marginTop: "0.25rem",
  },
  hint: {
    marginTop: "0.25rem",
    fontSize: "0.75rem",
    color: colors.textSecondary,
    fontStyle: "italic",
  },
  resultBox: {
    padding: "0.75rem 1rem",
    border: `1px solid ${colors.border}`,
    borderRadius: "0.375rem",
    background: colors.surface,
    display: "flex",
    gap: "1.5rem",
    fontSize: "0.875rem",
  },
  heading: {
    margin: "0 0 0.5rem",
    fontSize: "1rem",
  },
  subHeading: {
    margin: "0 0 0.5rem",
    fontSize: "0.875rem",
    fontWeight: 600,
  },
};
