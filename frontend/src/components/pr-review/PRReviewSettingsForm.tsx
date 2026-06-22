import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { EventAction, PRReviewListConfig, Workspace } from "../../types";
import { api } from "../../api";
import { useToast } from "../ui/Toast";
import { useIsReadOnly } from "../../hooks/usePublicMode";
import { colors } from "../../styles/tokens";
import { SingleChannelPicker } from "../ui/SingleChannelPicker";

// pr_review_list action の汎用設定タブ。
//
// PR レビューは Slack で完結する設計。レビュアー指定 / LGTM / 再レビューは
// Slack の sticky board 上で行うため、ここで設定するのは
// 「自動完了に必要な LGTM 数 (しきい値)」と、停滞 PR リマインド (旧 stale_pr_nudge
// アクション) の設定 (監視 repo / 催促チャンネル / stale 時間 / 自動催促時刻)。
//
// config は JSON 文字列。保存時は既存 config の他 key を温存し
// (NotificationsTab 等と同じマージ作法)、編集対象 key のみ差し替える。

const DEFAULT_LGTM_THRESHOLD = 2;
const HM_RE = /^\d{2}:\d{2}$/;
const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

function parseConfig(s: string): PRReviewListConfig {
  try {
    const cfg = JSON.parse(s ?? "{}");
    return cfg && typeof cfg === "object" ? (cfg as PRReviewListConfig) : {};
  } catch {
    return {};
  }
}

// config.lgtmThreshold から初期値を作る。未設定 / 不正値はデフォルト 2。
function initialThreshold(cfg: PRReviewListConfig): number {
  const v = cfg.lgtmThreshold;
  if (typeof v === "number" && Number.isInteger(v) && v >= 1) return v;
  return DEFAULT_LGTM_THRESHOLD;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function PRReviewSettingsForm({
  eventId,
  action,
  onSaved,
}: {
  eventId: string;
  action: EventAction;
  onSaved: () => void;
}) {
  const toast = useToast();
  const isReadOnly = useIsReadOnly();
  const initial = useMemo(() => parseConfig(action.config), [action.config]);
  const initialValue = useMemo(() => initialThreshold(initial), [initial]);
  const [threshold, setThreshold] = useState<string>(String(initialValue));
  const [saving, setSaving] = useState(false);

  // 停滞 PR リマインド設定 (旧 stale_pr_nudge アクションから畳み込み)。
  const [reposText, setReposText] = useState(
    asStringArray(initial.githubRepos).join("\n"),
  );
  const [channelId, setChannelId] = useState(
    typeof initial.nudgeChannelId === "string" ? initial.nudgeChannelId : "",
  );
  const [channelName, setChannelName] = useState<string>("");
  const [staleHours, setStaleHours] = useState(
    String(typeof initial.staleHours === "number" ? initial.staleHours : 48),
  );
  const [nudgeTime, setNudgeTime] = useState(
    typeof initial.nudgeTime === "string" ? initial.nudgeTime : "09:00",
  );
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);

  // workspace 一覧を取得 (1 件なら自動選択)。SingleChannelPicker に渡す。
  useEffect(() => {
    let cancelled = false;
    api.workspaces
      .list()
      .then((list) => {
        if (cancelled) return;
        const ws = Array.isArray(list) ? list : [];
        setWorkspaces(ws);
        if (ws.length >= 1) setWorkspaceId(ws[0].id);
      })
      .catch(() => {
        if (!cancelled) setWorkspaces([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const parsed = Number(threshold);
  const valid =
    threshold.trim() !== "" && Number.isInteger(parsed) && parsed >= 1;

  const handleSave = async () => {
    if (!valid) {
      toast.error("LGTM 必要数は 1 以上の整数で入力してください");
      return;
    }
    const repos = reposText
      .split(/[\n,]/)
      .map((r) => r.trim())
      .filter((r) => r !== "");
    const badRepo = repos.find((r) => !REPO_RE.test(r));
    if (badRepo) {
      toast.error(`監視 repo は "owner/repo" 形式で入力してください: ${badRepo}`);
      return;
    }
    const cid = channelId.trim();
    if (cid !== "" && !cid.startsWith("C")) {
      toast.error("催促チャンネルを選択し直してください");
      return;
    }
    const hours = Number(staleHours);
    if (!Number.isFinite(hours) || hours <= 0) {
      toast.error("stale 判定時間は 1 以上の数値で入力してください");
      return;
    }
    if (!HM_RE.test(nudgeTime.trim())) {
      toast.error("自動催促時刻は HH:MM 形式で入力してください");
      return;
    }
    setSaving(true);
    try {
      // 他 config key を温存したまま編集対象のみ差し替える (マージ保存作法)。
      const next: PRReviewListConfig = {
        ...initial,
        lgtmThreshold: parsed,
        githubRepos: repos,
        nudgeChannelId: cid === "" ? null : cid,
        staleHours: hours,
        nudgeTime: nudgeTime.trim(),
      };
      await api.events.actions.update(eventId, action.id, {
        config: JSON.stringify(next),
      });
      toast.success("保存しました");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  const showWorkspaceDropdown = workspaces !== null && workspaces.length >= 2;

  return (
    <div style={styles.wrap}>
      <h3 style={{ marginTop: 0 }}>PR レビュー設定</h3>
      <p style={styles.intro}>
        PR レビューは Slack で完結します。レビュアー指定・LGTM・再レビューは
        Slack の sticky board 上で行います。ここでは自動完了に必要な LGTM
        数（しきい値）と、停滞 PR リマインドを設定します。
      </p>

      <label style={styles.label} htmlFor="lgtm-threshold">
        LGTM 必要数（しきい値）
      </label>
      <input
        id="lgtm-threshold"
        type="number"
        min={1}
        step={1}
        value={threshold}
        onChange={(e) => setThreshold(e.target.value)}
        style={{
          ...styles.input,
          ...(valid ? {} : { borderColor: colors.danger }),
        }}
        disabled={isReadOnly || saving}
        aria-invalid={!valid}
      />
      <div style={styles.desc}>
        この数の LGTM が集まると PR レビューが自動で完了扱いになります。
        未設定の場合は {DEFAULT_LGTM_THRESHOLD} 件です。
      </div>
      {!valid && (
        <div style={styles.errorText}>1 以上の整数で入力してください</div>
      )}

      <hr style={styles.hr} />
      <h4 style={{ margin: "0 0 0.5rem" }}>停滞 PR リマインド</h4>
      <p style={styles.intro}>
        監視対象 GitHub repo の open PR のうち、一定時間更新の止まったものを
        レビュアー名指しで催促チャンネルへ送ります。「PR レビュー一覧」の
        「📣 停滞PRリマインド送信」ボタン、または平日 {nudgeTime} (JST) の自動
        cron で発火します。監視 repo / 催促チャンネルが空のときは送信されません。
      </p>

      <label style={styles.label} htmlFor="nudge-repos">
        監視する GitHub repo（1 行 1 つ・owner/repo）
      </label>
      <textarea
        id="nudge-repos"
        value={reposText}
        onChange={(e) => setReposText(e.target.value)}
        placeholder={"owner/repo\nko-tarou/leaders-meetup-bot"}
        disabled={isReadOnly || saving}
        rows={4}
        aria-label="監視する GitHub repo"
        style={{ ...styles.input, width: "100%", fontFamily: "monospace" }}
      />

      {showWorkspaceDropdown && (
        <>
          <label style={styles.label} htmlFor="nudge-ws">
            ワークスペース
          </label>
          <select
            id="nudge-ws"
            value={workspaceId}
            onChange={(e) => {
              setWorkspaceId(e.target.value);
              setChannelId("");
              setChannelName("");
            }}
            disabled={saving}
            aria-label="ワークスペース"
            style={{ ...styles.input, width: "100%" }}
          >
            {workspaces!.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </>
      )}

      <label style={styles.label}>催促を投稿するチャンネル</label>
      <SingleChannelPicker
        value={channelId}
        channelName={channelName}
        workspaceId={workspaceId}
        onChange={(id, name) => {
          setChannelId(id);
          setChannelName(name);
        }}
        disabled={isReadOnly || saving}
      />

      <label style={styles.label} htmlFor="nudge-stale">
        stale 判定時間（時間）
      </label>
      <input
        id="nudge-stale"
        type="number"
        min={1}
        value={staleHours}
        onChange={(e) => setStaleHours(e.target.value)}
        disabled={isReadOnly || saving}
        aria-label="stale 判定時間"
        style={styles.input}
      />

      <label style={styles.label} htmlFor="nudge-time">
        自動催促時刻（JST・HH:MM）
      </label>
      <input
        id="nudge-time"
        type="time"
        value={nudgeTime}
        onChange={(e) => setNudgeTime(e.target.value)}
        disabled={isReadOnly || saving}
        aria-label="自動催促時刻"
        style={styles.input}
      />

      <div>
        <button
          type="button"
          onClick={handleSave}
          style={styles.saveBtn}
          disabled={isReadOnly || saving || !valid}
        >
          {saving ? "保存中..." : "保存"}
        </button>
      </div>
    </div>
  );
}

const styles = {
  wrap: { padding: "1rem" } as CSSProperties,
  intro: {
    fontSize: "0.85rem",
    color: colors.textSecondary,
    marginTop: 0,
    marginBottom: "1rem",
    lineHeight: 1.6,
  } as CSSProperties,
  label: {
    display: "block",
    fontSize: "0.85rem",
    color: colors.textSecondary,
    marginBottom: "0.5rem",
    marginTop: "0.75rem",
  } as CSSProperties,
  input: {
    width: "8rem",
    padding: "0.375rem 0.5rem",
    border: `1px solid ${colors.border}`,
    borderRadius: "0.25rem",
    fontSize: "0.875rem",
    background: colors.background,
    color: colors.text,
    boxSizing: "border-box",
  } as CSSProperties,
  desc: {
    fontSize: "0.8rem",
    color: colors.textMuted,
    marginTop: "0.5rem",
  } as CSSProperties,
  errorText: {
    color: colors.danger,
    fontSize: "0.8rem",
    marginTop: "0.25rem",
  } as CSSProperties,
  hr: {
    border: "none",
    borderTop: `1px solid ${colors.border}`,
    margin: "1.25rem 0 1rem",
  } as CSSProperties,
  saveBtn: {
    background: colors.primary,
    color: colors.textInverse,
    border: "none",
    padding: "0.5rem 1rem",
    borderRadius: "0.25rem",
    cursor: "pointer",
    fontSize: "0.875rem",
    marginTop: "1rem",
  } as CSSProperties,
};
