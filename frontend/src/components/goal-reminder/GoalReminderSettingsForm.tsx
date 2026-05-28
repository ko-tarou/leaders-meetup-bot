import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { EventAction, Workspace } from "../../types";
import { api } from "../../api";
import { useToast } from "../ui/Toast";
import { settingsFormStyles as s } from "../morning-standup/settingsFormStyles";
import { SingleChannelPicker } from "../ui/SingleChannelPicker";

// 宗教イベント goal_reminder PR2: 目標リマインダーの設定タブ。
// config schema (backend services/goal-reminder.ts と一致):
//   { schemaVersion, workspaceId, channelId,
//     morningTime, nightTime, frequency ("daily"|"weekday"),
//     mention ("none"|"channel"), goalText,
//     morningTemplate, nightTemplate }
// - workspaceId / channelId 未設定 → cron / 手動送信ともに not_configured で skip。
// - {goal} は backend で goalText に置換される (placeholder ヒントを出す)。
// - ID は一切 UI に出さない (workspace / channel は NAME 表示)。

const DEFAULT_MORNING_TIME = "08:00";
const DEFAULT_NIGHT_TIME = "22:00";
const DEFAULT_GOAL_TEXT = "次世代の宗教を作る";
const DEFAULT_MORNING_TEMPLATE =
  "🔥 私たちの目標は『{goal}』です。これに向けて全力で、死に物狂いで頑張りましょう。";
const DEFAULT_NIGHT_TEMPLATE = "🌙 『{goal}』に向けて、今日も一日お疲れ様でした。";
const HM_RE = /^\d{2}:\d{2}$/;

type Frequency = "daily" | "weekday";
type Mention = "none" | "channel";

type Config = {
  schemaVersion?: number;
  workspaceId?: string | null;
  channelId?: string | null;
  morningTime?: string;
  nightTime?: string;
  frequency?: Frequency;
  mention?: Mention;
  goalText?: string;
  morningTemplate?: string;
  nightTemplate?: string;
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

function isValidHm(hm: string): boolean {
  if (!HM_RE.test(hm)) return false;
  const [h, min] = hm.split(":").map(Number);
  return h >= 0 && h <= 23 && min >= 0 && min <= 59;
}

export function GoalReminderSettingsForm({
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

  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [workspaceId, setWorkspaceId] = useState(initial.workspaceId ?? "");
  const [channelId, setChannelId] = useState(initial.channelId ?? "");
  const [channelName, setChannelName] = useState<string>("");
  const [morningTime, setMorningTime] = useState(initial.morningTime ?? DEFAULT_MORNING_TIME);
  const [nightTime, setNightTime] = useState(initial.nightTime ?? DEFAULT_NIGHT_TIME);
  const [frequency, setFrequency] = useState<Frequency>(
    initial.frequency === "weekday" ? "weekday" : "daily",
  );
  const [mention, setMention] = useState<Mention>(
    initial.mention === "channel" ? "channel" : "none",
  );
  const [goalText, setGoalText] = useState(initial.goalText ?? DEFAULT_GOAL_TEXT);
  const [morningTemplate, setMorningTemplate] = useState(
    initial.morningTemplate ?? DEFAULT_MORNING_TEMPLATE,
  );
  const [nightTemplate, setNightTemplate] = useState(
    initial.nightTemplate ?? DEFAULT_NIGHT_TEMPLATE,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // workspace 一覧 (1 件かつ未設定なら自動選択)
  useEffect(() => {
    let cancelled = false;
    api.workspaces
      .list()
      .then((list) => {
        if (cancelled) return;
        const ws = Array.isArray(list) ? list : [];
        setWorkspaces(ws);
        if (!initial.workspaceId && ws.length >= 1) setWorkspaceId(ws[0].id);
      })
      .catch(() => {
        if (!cancelled) setWorkspaces([]);
      });
    return () => {
      cancelled = true;
    };
  }, [initial.workspaceId]);

  const handleSave = async () => {
    setError(null);
    if (!workspaceId) {
      setError("ワークスペースを選択してください");
      return;
    }
    const cid = channelId.trim();
    if (cid === "" || !cid.startsWith("C")) {
      setError("投稿チャンネルを選択してください");
      return;
    }
    if (!isValidHm(morningTime) || !isValidHm(nightTime)) {
      setError("時刻は HH:MM 形式で入力してください");
      return;
    }
    const next: Config = {
      ...initial,
      schemaVersion: 1,
      workspaceId,
      channelId: cid,
      morningTime,
      nightTime,
      frequency,
      mention,
      goalText: goalText.trim() === "" ? DEFAULT_GOAL_TEXT : goalText,
      morningTemplate: morningTemplate.trim() === "" ? DEFAULT_MORNING_TEMPLATE : morningTemplate,
      nightTemplate: nightTemplate.trim() === "" ? DEFAULT_NIGHT_TEMPLATE : nightTemplate,
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
      <h3 style={{ marginTop: 0 }}>目標リマインダー 設定</h3>
      <p style={s.intro}>
        チームの目標を毎朝・毎夜に Slack チャンネルへ自動投稿します。
        ワークスペースとチャンネルが未設定のときは投稿されません。
        文面の <code>{"{goal}"}</code> は目標テキストに置換されます。
      </p>

      {error && <div style={s.errorBox}>{error}</div>}

      <Field label="ワークスペース">
        {workspaces === null ? (
          <div style={s.hint}>取得中...</div>
        ) : workspaces.length === 0 ? (
          <div style={s.hint}>ワークスペースがありません。先に登録してください。</div>
        ) : (
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
            <option value="">選択してください</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        )}
      </Field>

      <Field label="投稿チャンネル">
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

      <Field label="朝の投稿時刻 (JST)">
        <input
          type="time"
          step={300}
          value={morningTime}
          onChange={(e) => setMorningTime(e.target.value)}
          disabled={saving}
          aria-label="朝の投稿時刻"
          style={{ ...s.input, width: "10rem" }}
        />
      </Field>

      <Field label="夜の投稿時刻 (JST)">
        <input
          type="time"
          step={300}
          value={nightTime}
          onChange={(e) => setNightTime(e.target.value)}
          disabled={saving}
          aria-label="夜の投稿時刻"
          style={{ ...s.input, width: "10rem" }}
        />
        <div style={s.hint}>※ cron 粒度上 1-5 分のズレが発生します</div>
      </Field>

      <Field label="投稿頻度">
        <select
          value={frequency}
          onChange={(e) => setFrequency(e.target.value as Frequency)}
          disabled={saving}
          aria-label="投稿頻度"
          style={{ ...s.input, width: "12rem" }}
        >
          <option value="daily">毎日</option>
          <option value="weekday">平日のみ</option>
        </select>
      </Field>

      <Field label="メンション">
        <select
          value={mention}
          onChange={(e) => setMention(e.target.value as Mention)}
          disabled={saving}
          aria-label="メンション"
          style={{ ...s.input, width: "12rem" }}
        >
          <option value="none">なし</option>
          <option value="channel">@channel</option>
        </select>
      </Field>

      <Field label="目標テキスト">
        <input
          type="text"
          value={goalText}
          onChange={(e) => setGoalText(e.target.value)}
          placeholder={DEFAULT_GOAL_TEXT}
          disabled={saving}
          aria-label="目標テキスト"
          style={s.input}
        />
        <div style={s.hint}>
          文面の <code>{"{goal}"}</code> がこのテキストに置換されます。
        </div>
      </Field>

      <Field label="朝の文面">
        <textarea
          value={morningTemplate}
          onChange={(e) => setMorningTemplate(e.target.value)}
          placeholder={DEFAULT_MORNING_TEMPLATE}
          disabled={saving}
          rows={3}
          aria-label="朝の文面"
          style={{ ...s.input, fontFamily: "monospace", resize: "vertical" }}
        />
        <div style={s.hint}>
          <code>{"{goal}"}</code> は目標テキストに置換されます。
        </div>
      </Field>

      <Field label="夜の文面">
        <textarea
          value={nightTemplate}
          onChange={(e) => setNightTemplate(e.target.value)}
          placeholder={DEFAULT_NIGHT_TEMPLATE}
          disabled={saving}
          rows={3}
          aria-label="夜の文面"
          style={{ ...s.input, fontFamily: "monospace", resize: "vertical" }}
        />
        <div style={s.hint}>
          <code>{"{goal}"}</code> は目標テキストに置換されます。
        </div>
      </Field>

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
