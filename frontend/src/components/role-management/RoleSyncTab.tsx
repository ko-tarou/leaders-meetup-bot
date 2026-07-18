import { useState, type CSSProperties } from "react";
import type {
  ChannelDiff,
  EventAction,
  SlackUser,
  SyncDiffResponse,
  SyncResult,
} from "../../types";
import { api } from "../../api";
import { useToast } from "../ui/Toast";
import { useConfirm } from "../ui/ConfirmDialog";
import { useIsReadOnly } from "../../hooks/usePublicMode";
import { colors } from "../../styles/tokens";

// Sprint 24 / role_management:
// 「同期」タブ。
// - 「diff を計算」ボタンで sync-diff を呼び、各 channel ごとに
//   invite/kick の checkbox を表示
// - クイックボタン (全選択 / invite のみ / kick のみ / 全クリア) と
//   各 channel × invite/kick の個別 toggle で実行範囲を絞れる
// - 「選択分を実行」で operations 配列を BE に送り、selective 実行する
//
// 確認ダイアログを必ず挟む (kick が破壊的操作のため)。
//
// Slack user ID → 表示名解決はベストエフォート: workspace-members を
// fetch してキャッシュし、解決できないときは ID をそのまま表示する。

type Config = { workspaceId?: string };

// diff 計算の分割は「サーバー側の subrequest 予算」が主導する。フロントは
// offset=0 から呼び、レスポンスの nextOffset を辿って結果を連結するだけ。
// (旧実装は「5 channel/req」で分割していたが、1 channel が members ページングで
//  最大 20 subrequest を消費し得る & getChannelList が毎回最大 20 subrequest を
//  使うため、チャンネル数では上限を制御できず "Too many subrequests" が再発した。
//  → サーバーが subrequest を厳密にカウントして予算手前で nextOffset を返す方式に変更。)

function parseConfig(raw: string): Config {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// sync-diff を offset ページングで全 channel 分を集約する。1 リクエストが処理する
// channel 数はサーバーの subrequest 予算が決め、nextOffset で継続位置が返る。
// フロントは nextOffset を辿るだけ (limit は渡さない = 予算に委ねる)。
// onProgress は (処理済み channel 数, 総 channel 数) を都度通知する (任意)。
async function fetchDiffPaged(
  eventId: string,
  actionId: string,
  onProgress?: (done: number, total: number) => void,
): Promise<SyncDiffResponse> {
  const channels: SyncDiffResponse["channels"] = [];
  let offset = 0;
  let workspaceId = "";
  // 安全弁: 想定外に nextOffset が進み続けても無限ループしないよう上限を設ける。
  const MAX_PAGES = 2000;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await api.roles.syncDiff(eventId, actionId, { offset });
    workspaceId = res.workspaceId;
    channels.push(...res.channels);
    const total = res.total ?? channels.length;
    onProgress?.(channels.length, total);
    if (res.nextOffset === null || res.nextOffset === undefined) break;
    // 前進しない (nextOffset が offset 以下) 場合も無限ループ防止で打ち切る。
    if (res.nextOffset <= offset) break;
    offset = res.nextOffset;
  }
  return { workspaceId, channels };
}

type Props = {
  eventId: string;
  action: EventAction;
};

// 各 channel に対する「invite/kick を実行するか」フラグ。
type ChannelOps = { invite: boolean; kick: boolean };

export function RoleSyncTab({ eventId, action }: Props) {
  const toast = useToast();
  const { confirm } = useConfirm();
  const isReadOnly = useIsReadOnly();
  const cfg = parseConfig(action.config);
  const workspaceId = cfg.workspaceId;
  const [diff, setDiff] = useState<SyncDiffResponse | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  // 分割 diff 計算の進捗 (処理済み channel / 総 channel)。null = 非表示。
  const [diffProgress, setDiffProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [syncing, setSyncing] = useState(false);
  // chunk 実行の進捗 (処理済みチャンネル / 全チャンネル)。null = 非実行中。
  const [syncProgress, setSyncProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  // per-channel の checkbox 状態。channelId をキーに { invite, kick } を保持する。
  const [ops, setOps] = useState<Record<string, ChannelOps>>({});
  // Slack user ID → 表示名のキャッシュ (best-effort)。
  const [userMap, setUserMap] = useState<Record<string, SlackUser>>({});

  // 「diff を計算」: sync-diff を取得して、各 channel に差分があれば
  // 対応する方向のチェックボックスを default で ON にする。
  const fetchDiff = async () => {
    setDiffLoading(true);
    setDiffError(null);
    setSyncResult(null);
    setDiffProgress(null);
    try {
      const res = await fetchDiffPaged(eventId, action.id, (done, total) =>
        setDiffProgress({ done, total }),
      );
      setDiff(res);
      // default: 差分があれば該当方向 true、なければ false
      const initialOps: Record<string, ChannelOps> = {};
      for (const c of res.channels) {
        initialOps[c.channelId] = {
          invite: c.toInvite.length > 0,
          kick: c.toKick.length > 0,
        };
      }
      setOps(initialOps);

      // 表示名解決 (best-effort): まだ取れていなければ workspace-members を fetch。
      // Slack の users.list scope が無いと 502 で失敗するので、その時は
      // 黙って ID 表示にフォールバックする。
      if (Object.keys(userMap).length === 0) {
        try {
          const members = await api.roles.workspaceMembers(eventId, action.id);
          const map: Record<string, SlackUser> = {};
          for (const m of members) map[m.id] = m;
          setUserMap(map);
        } catch {
          /* noop: ID 表示にフォールバック */
        }
      }
    } catch (e) {
      setDiffError(
        e instanceof Error ? e.message : "diff の取得に失敗しました",
      );
    } finally {
      setDiffLoading(false);
      setDiffProgress(null);
    }
  };

  // 全 channel に対して invite/kick を一括設定 (クイックボタン)。
  const setAllOps = (invite: boolean, kick: boolean) => {
    if (!diff) return;
    const next: Record<string, ChannelOps> = {};
    for (const c of diff.channels) {
      // 差分が 0 件の方向は強制的に false (chexbox 自体 disabled)
      next[c.channelId] = {
        invite: invite && c.toInvite.length > 0,
        kick: kick && c.toKick.length > 0,
      };
    }
    setOps(next);
  };

  // 個別 channel × 方向の toggle。
  const toggle = (channelId: string, key: "invite" | "kick") => {
    setOps((prev) => {
      const cur = prev[channelId] ?? { invite: false, kick: false };
      return { ...prev, [channelId]: { ...cur, [key]: !cur[key] } };
    });
  };

  // 実行: ops から operations[] を組み立て、件数を確認ダイアログで提示してから
  // sync を呼ぶ。invite=false かつ kick=false の channel は送信から除外する
  // (BE 側でも結果は同じだがネットワーク量を抑える)。
  const runSync = async () => {
    if (!diff) {
      toast.error("先に diff を計算してください");
      return;
    }
    const operations = diff.channels
      .map((c) => {
        const o = ops[c.channelId] ?? { invite: false, kick: false };
        return { channelId: c.channelId, invite: o.invite, kick: o.kick };
      })
      .filter((o) => o.invite || o.kick);
    if (operations.length === 0) {
      toast.error("実行する操作がありません");
      return;
    }
    // 件数を集計してダイアログに出す。
    let totalInvites = 0;
    let totalKicks = 0;
    for (const o of operations) {
      const c = diff.channels.find((d) => d.channelId === o.channelId);
      if (!c) continue;
      if (o.invite) totalInvites += c.toInvite.length;
      if (o.kick) totalKicks += c.toKick.length;
    }
    const ok = await confirm({
      title: "同期実行",
      message: `${operations.length} チャンネルに対し、invite ${totalInvites} 件 / kick ${totalKicks} 件 を実行します。よろしいですか？`,
      variant: "danger",
      confirmLabel: "実行",
    });
    if (!ok) return;
    setSyncing(true);
    setSyncResult(null);
    setSyncProgress({ done: 0, total: operations.length });
    try {
      // Cloudflare Workers の 1 invocation あたり subrequest 上限を超えないよう、
      // operations を CHANNELS_PER_REQUEST 個ずつに分割して逐次実行する。加えて
      // サーバーが subrequest 予算を超える手前で未処理分を deferred として返すので、
      // それをキューに戻して空になるまで再送する (大量 kick 等でも上限に当たらない)。
      const CHANNELS_PER_REQUEST = 5;
      const res: SyncResult = { invited: 0, kicked: 0, errors: [] };
      const queue = [...operations];
      const totalOps = operations.length;
      let done = 0;
      // 安全弁: deferred が減らない異常時に無限ループしないよう上限を設ける。
      const MAX_REQUESTS = totalOps * 20 + 100;
      let requests = 0;
      while (queue.length > 0 && requests < MAX_REQUESTS) {
        requests++;
        const batch = queue.splice(0, CHANNELS_PER_REQUEST);
        const part = await api.roles.sync(eventId, action.id, {
          operations: batch,
        });
        res.invited += part.invited;
        res.kicked += part.kicked;
        res.errors.push(...part.errors);
        // 未処理分は次リクエストへ (再送されるチャンネルは done に数えない)。
        const deferred = part.deferred ?? [];
        if (deferred.length > 0) queue.unshift(...deferred);
        done += batch.length - deferred.length;
        setSyncProgress({ done: Math.min(done, totalOps), total: totalOps });
      }
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
        const next = await fetchDiffPaged(eventId, action.id);
        setDiff(next);
        const nextOps: Record<string, ChannelOps> = {};
        for (const c of next.channels) {
          nextOps[c.channelId] = {
            invite: c.toInvite.length > 0,
            kick: c.toKick.length > 0,
          };
        }
        setOps(nextOps);
      } catch {
        /* noop: 失敗しても sync 自体は完了している */
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "同期に失敗しました");
    } finally {
      setSyncing(false);
      setSyncProgress(null);
    }
  };

  // ID → 表示名: workspaceMembers の cache から「@displayName (ID)」形式で返す。
  // cache に無ければ ID をそのまま返す。
  const formatUser = (id: string): string => {
    const u = userMap[id];
    if (!u) return id;
    const name = u.displayName?.trim() || u.realName?.trim() || u.name;
    return name ? `@${name}` : id;
  };

  if (!workspaceId) {
    return (
      <div style={s.warn}>
        ワークスペースが未設定です。「その他設定」タブから登録してください。
      </div>
    );
  }

  // diff の集計 (画面上部のサマリー & 確定実行ボタン用)。
  const totalChannels = diff?.channels.length ?? 0;
  const totalInviteAll = diff?.channels.reduce(
    (acc, c) => acc + c.toInvite.length,
    0,
  ) ?? 0;
  const totalKickAll = diff?.channels.reduce(
    (acc, c) => acc + c.toKick.length,
    0,
  ) ?? 0;

  // 現在チェック ON の合計 (実行時の予告に使う)。
  let plannedInvites = 0;
  let plannedKicks = 0;
  if (diff) {
    for (const c of diff.channels) {
      const o = ops[c.channelId];
      if (!o) continue;
      if (o.invite) plannedInvites += c.toInvite.length;
      if (o.kick) plannedKicks += c.toKick.length;
    }
  }

  return (
    <div>
      <div style={s.hintBox}>
        bot を新しいチャンネルに招待するには「ワークスペース管理」ページの
        「bot を一括招待」を実行してください。bot は private channel に自分で
        join できないため、admin 権限による一括招待が必要です。
      </div>

      <h3 style={s.heading}>メンバー同期 (per-channel 実行)</h3>
      <p style={s.desc}>
        ロール × メンバー × チャンネル の対応関係から「各チャンネルに居るべき
        メンバー」を計算し、Slack 側の現状と diff を取って invite / kick で同期
        します。各チャンネルごとに invite / kick のどちらを実行するか
        個別に選択できます。bot 自身は kick 対象から除外されます。
      </p>

      <div style={s.actionRow}>
        <button
          onClick={fetchDiff}
          disabled={isReadOnly || diffLoading || syncing}
          style={s.secondaryBtn}
        >
          {diffLoading
            ? diffProgress
              ? `計算中... ${diffProgress.done}/${diffProgress.total} チャンネル`
              : "計算中..."
            : "diff を計算"}
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
            workspace: {diff.workspaceId} / 対象 {totalChannels} チャンネル / 招待
            候補 {totalInviteAll} 件 / 退出候補 {totalKickAll} 件
          </div>

          {totalChannels === 0 ? (
            <div style={s.empty}>
              管理対象のチャンネルがありません。「ロール」タブから各ロールに
              チャンネルを割当ててください。
            </div>
          ) : (
            <>
              {/* クイック選択ボタン群 */}
              <div style={s.quickRow}>
                <button
                  type="button"
                  onClick={() => setAllOps(true, true)}
                  style={s.quickBtn}
                >
                  全選択
                </button>
                <button
                  type="button"
                  onClick={() => setAllOps(true, false)}
                  style={s.quickBtn}
                >
                  全 invite のみ
                </button>
                <button
                  type="button"
                  onClick={() => setAllOps(false, true)}
                  style={s.quickBtn}
                >
                  全 kick のみ
                </button>
                <button
                  type="button"
                  onClick={() => setAllOps(false, false)}
                  style={s.quickBtn}
                >
                  全クリア
                </button>
              </div>

              {/* per-channel control */}
              <div style={{ display: "grid", gap: "0.5rem" }}>
                {diff.channels.map((c) => (
                  <ChannelDiffRow
                    key={c.channelId}
                    diff={c}
                    ops={
                      ops[c.channelId] ?? { invite: false, kick: false }
                    }
                    onToggle={(key) => toggle(c.channelId, key)}
                    formatUser={formatUser}
                  />
                ))}
              </div>

              <div style={{ ...s.actionRow, marginTop: "1rem" }}>
                <button
                  onClick={runSync}
                  disabled={isReadOnly || syncing || diffLoading}
                  style={s.primaryBtn}
                >
                  {syncing
                    ? syncProgress
                      ? `同期中... ${syncProgress.done}/${syncProgress.total} チャンネル`
                      : "実行中..."
                    : `選択分を実行 (invite ${plannedInvites} / kick ${plannedKicks})`}
                </button>
              </div>
            </>
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

function ChannelDiffRow({
  diff,
  ops,
  onToggle,
  formatUser,
}: {
  diff: ChannelDiff;
  ops: ChannelOps;
  onToggle: (key: "invite" | "kick") => void;
  formatUser: (id: string) => string;
}) {
  const noChange =
    !diff.error && diff.toInvite.length === 0 && diff.toKick.length === 0;
  return (
    <div style={s.diffRow}>
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem" }}>
        <strong>#{diff.channelName}</strong>
        <span style={s.metaInline}>{diff.channelId}</span>
        {noChange && <span style={s.okBadge}>差分なし</span>}
      </div>
      {diff.error && (
        <div style={{ ...s.error, marginTop: "0.5rem" }}>
          取得失敗: {diff.error}
        </div>
      )}
      {!diff.error && !noChange && (
        <div style={{ marginTop: "0.5rem" }}>
          {/* checkbox row */}
          <div style={s.checkboxRow}>
            <label
              style={{
                ...s.checkboxLabel,
                opacity: diff.toInvite.length === 0 ? 0.4 : 1,
              }}
            >
              <input
                type="checkbox"
                checked={ops.invite}
                disabled={diff.toInvite.length === 0}
                onChange={() => onToggle("invite")}
              />
              <span style={s.inviteLabel}>
                invite ({diff.toInvite.length})
              </span>
            </label>
            <label
              style={{
                ...s.checkboxLabel,
                opacity: diff.toKick.length === 0 ? 0.4 : 1,
              }}
            >
              <input
                type="checkbox"
                checked={ops.kick}
                disabled={diff.toKick.length === 0}
                onChange={() => onToggle("kick")}
              />
              <span style={s.kickLabel}>kick ({diff.toKick.length})</span>
            </label>
          </div>

          {diff.toInvite.length > 0 && (
            <div style={s.diffSection}>
              <span style={s.inviteLabel}>+ invite 候補:</span>{" "}
              <span style={s.diffUsers}>
                {diff.toInvite.map(formatUser).join(", ")}
              </span>
            </div>
          )}
          {diff.toKick.length > 0 && (
            <div style={s.diffSection}>
              <span style={s.kickLabel}>− kick 候補:</span>{" "}
              <span style={s.diffUsers}>
                {diff.toKick.map(formatUser).join(", ")}
              </span>
            </div>
          )}
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
  hintBox: {
    padding: "0.75rem 1rem",
    marginBottom: "1.25rem",
    background: colors.surface,
    border: `1px solid ${colors.border}`,
    borderRadius: "0.375rem",
    fontSize: "0.8rem",
    color: colors.textSecondary,
  },
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
  quickRow: {
    display: "flex",
    gap: "0.5rem",
    marginBottom: "0.75rem",
    flexWrap: "wrap",
  },
  quickBtn: {
    padding: "0.25rem 0.625rem",
    fontSize: "0.75rem",
    border: `1px solid ${colors.borderStrong}`,
    background: colors.background,
    borderRadius: "0.25rem",
    cursor: "pointer",
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
  checkboxRow: {
    display: "flex",
    gap: "1.25rem",
    fontSize: "0.875rem",
  },
  checkboxLabel: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.375rem",
    cursor: "pointer",
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
