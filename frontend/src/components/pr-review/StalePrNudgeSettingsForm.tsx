import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { EventAction, Workspace } from "../../types";
import { api } from "../../api";
import { useToast } from "../ui/Toast";
import { SingleChannelPicker } from "../ui/SingleChannelPicker";
import { settingsFormStyles as s } from "../morning-standup/settingsFormStyles";

// stale-pr-nudge アクション専用の最小設定タブ。
//
// 【非推奨】Feature ② で stale-nudge 設定は pr_review_list アクションの設定タブへ
// 畳み込まれた。新規は pr_review_list の「停滞 PR リマインド」を使うこと。この
// 専用アクションは既存登録の後方互換のためにのみ残している。
//
// このアクションを登録すると「PR レビュー一覧」に「📣 リマインド送信」ボタンが出る。
// ボタンの押下で停滞 (config.staleHours 以上更新の無い) GitHub open PR を
// レビュアー名指しで共有チャンネルへ催促する (src/services/stale-pr-nudge.ts)。
//
// config schema (BE parseStalePrNudgeConfig と一致させる):
//   githubRepos: string[]  // "owner/repo" 配列。必須 (空なら no-op = 送信されない)
//   nudgeChannelId: string // 催促を投稿する共有チャンネル ID (Cxxxx)。必須
//   staleHours?: number    // 既定 48
//   nudgeTime?: string     // "HH:MM" (JST)。自動 cron の発火時刻。既定 "09:00"
//
// 設定が未完 (repos 空 / channel 空) でもボタン自体は出るが、送信は no-op になる。
type Config = {
  schemaVersion?: number;
  githubRepos?: string[];
  nudgeChannelId?: string | null;
  staleHours?: number;
  nudgeTime?: string;
};

const HM_RE = /^\d{2}:\d{2}$/;
const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

function parseConfig(raw: string | null | undefined): Config {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? (o as Config) : {};
  } catch {
    return {};
  }
}

export function StalePrNudgeSettingsForm({
  eventId,
  action,
  onSaved,
}: {
  eventId: string;
  action: EventAction;
  onSaved: () => void;
}) {
  const toast = useToast();
  const initial = useMemo(() => parseConfig(action.config), [action.config]);
  // 1 行 1 repo の textarea で編集する (UX が簡単で誤入力しにくい)。
  const [reposText, setReposText] = useState(
    (initial.githubRepos ?? []).join("\n"),
  );
  const [channelId, setChannelId] = useState(initial.nudgeChannelId ?? "");
  const [channelName, setChannelName] = useState<string>("");
  const [staleHours, setStaleHours] = useState(
    String(initial.staleHours ?? 48),
  );
  const [nudgeTime, setNudgeTime] = useState(initial.nudgeTime ?? "09:00");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);

  // SingleChannelPicker に渡す workspace を取得 (1 件なら自動選択)。
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

  const handleSave = async () => {
    setError(null);
    const repos = reposText
      .split(/[\n,]/)
      .map((r) => r.trim())
      .filter((r) => r !== "");
    const badRepo = repos.find((r) => !REPO_RE.test(r));
    if (badRepo) {
      setError(`監視 repo は "owner/repo" 形式で入力してください: ${badRepo}`);
      return;
    }
    const cid = channelId.trim();
    if (cid !== "" && !cid.startsWith("C")) {
      setError("催促チャンネルを選択し直してください");
      return;
    }
    const hours = Number(staleHours);
    if (!Number.isFinite(hours) || hours <= 0) {
      setError("stale 判定時間は 1 以上の数値で入力してください");
      return;
    }
    const time = nudgeTime.trim();
    if (!HM_RE.test(time)) {
      setError("自動催促時刻は HH:MM 形式で入力してください");
      return;
    }

    const next: Config = {
      ...initial,
      schemaVersion: initial.schemaVersion ?? 1,
      githubRepos: repos,
      nudgeChannelId: cid === "" ? null : cid,
      staleHours: hours,
      nudgeTime: time,
    };

    setSaving(true);
    try {
      await api.events.actions.update(eventId, action.id, {
        config: JSON.stringify(next),
      });
      toast.success("保存しました");
      onSaved();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "保存に失敗しました";
      setError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={s.wrap}>
      <h3 style={{ marginTop: 0 }}>停滞 PR リマインド設定</h3>
      <p style={s.intro}>
        監視対象 GitHub repo の open PR のうち、一定時間更新の止まったものを
        レビュアー名指しで共有チャンネルへ催促します。設定後、「PR レビュー一覧」の
        「📣 リマインド送信」ボタン、または平日 {nudgeTime} (JST) の自動 cron で発火します。
        監視 repo / 催促チャンネルが空のときは送信されません (no-op)。
      </p>

      {error && <div style={s.errorBox}>{error}</div>}

      <Field label="監視する GitHub repo (1 行 1 つ・owner/repo)">
        <textarea
          value={reposText}
          onChange={(e) => setReposText(e.target.value)}
          placeholder={"owner/repo\nko-tarou/leaders-meetup-bot"}
          disabled={saving}
          rows={4}
          aria-label="監視する GitHub repo"
          style={{ ...s.input, fontFamily: "monospace", resize: "vertical" }}
        />
        <div style={s.hint}>
          public repo は未認証でも動作 (60 req/hour)。private / 多数 repo は GITHUB_TOKEN secret が必要です。
        </div>
      </Field>

      {workspaces !== null && workspaces.length >= 2 && (
        <Field label="ワークスペース">
          <select
            value={workspaceId}
            onChange={(e) => {
              setWorkspaceId(e.target.value);
              setChannelId("");
              setChannelName("");
            }}
            disabled={saving}
            aria-label="ワークスペース"
            style={s.input}
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field label="催促を投稿するチャンネル">
        <SingleChannelPicker
          value={channelId}
          channelName={channelName}
          workspaceId={workspaceId}
          onChange={(id, name) => {
            setChannelId(id);
            setChannelName(name);
          }}
          disabled={saving}
        />
      </Field>

      <Field label="stale 判定時間 (時間)">
        <input
          type="number"
          min={1}
          value={staleHours}
          onChange={(e) => setStaleHours(e.target.value)}
          disabled={saving}
          aria-label="stale 判定時間"
          style={{ ...s.input, width: "10rem" }}
        />
        <div style={s.hint}>PR が何時間更新されなければ催促対象とするか (既定 48)。</div>
      </Field>

      <Field label="自動催促時刻 (JST・HH:MM)">
        <input
          type="time"
          value={nudgeTime}
          onChange={(e) => setNudgeTime(e.target.value)}
          disabled={saving}
          aria-label="自動催促時刻"
          style={{ ...s.input, width: "10rem" }}
        />
        <div style={s.hint}>
          平日この時刻を中心に自動催促します。手動「📣 リマインド送信」はこの時刻に関わらず即発火します。
        </div>
      </Field>

      <div style={s.tipBox}>
        <strong>💡 ヒント</strong>
        <ul style={s.tipList}>
          <li>レビュアーを @メンションで名指しするには github_user_mappings の登録が必要です (未登録なら @github:login 表示)。</li>
          <li>同一 PR は同日 1 回まで (手動で連打しても二重送信されません)。</li>
        </ul>
      </div>

      <div style={s.actions}>
        <button type="button" onClick={handleSave} disabled={saving} style={s.saveBtn}>
          {saving ? "保存中..." : "保存"}
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={s.field}>
      <label style={s.fieldLabel}>{label}</label>
      {children}
    </div>
  );
}
