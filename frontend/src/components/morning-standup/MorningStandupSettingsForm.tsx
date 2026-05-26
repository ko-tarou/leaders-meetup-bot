import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { EventAction, Workspace } from "../../types";
import { api } from "../../api";
import { useToast } from "../ui/Toast";
import { colors } from "../../styles/tokens";
import { settingsFormStyles as s } from "./settingsFormStyles";
import { SingleChannelPicker } from "../ui/SingleChannelPicker";
import { RoleNameDisplay } from "../role-management/RoleNameDisplay";

// 003 PR7 → PR8 → PR9: morning_standup アクション専用の設定タブ。
// config schema: {
//   channelId, roleId?, themes?,
//   messageTemplates?: { reminder?: string; close?: string },
//   reminderTime?: "HH:MM" (PR9), closeTime?: "HH:MM" (PR9)
// }
// - channelId 空欄は cron skip (一時停止用途)
// - PR9: ChannelSelector → SingleChannelPicker (検索 + ページング)。
//        workspace dropdown を追加 (1 件しか無ければ隠して自動選択)
// - PR9: reminderTime / closeTime を編集可能に (default 07:30 / 08:00)

type Themes = { mon: string; tue: string; wed: string; thu: string; fri: string };
type MessageTemplates = { reminder?: string; close?: string };
type Config = {
  channelId?: string;
  roleId?: string;
  themes?: Partial<Themes>;
  messageTemplates?: MessageTemplates;
  reminderTime?: string;
  closeTime?: string;
};

const DEFAULT_THEMES: Themes = {
  mon: "ハードウェア", tue: "フロントエンド", wed: "バックエンド",
  thu: "Android", fri: "Unity",
};
const KEYS: Array<keyof Themes> = ["mon", "tue", "wed", "thu", "fri"];
const LABEL: Record<keyof Themes, string> = {
  mon: "月曜", tue: "火曜", wed: "水曜", thu: "木曜", fri: "金曜",
};
const DEFAULT_REMINDER_TIME = "07:30";
const DEFAULT_CLOSE_TIME = "08:00";
const HM_RE = /^\d{2}:\d{2}$/;

const DEFAULT_REMINDER =
  ":books: *おはようございます！今日も朝活会あります*\n" +
  "今日のテーマ: *{theme}* ({dayLabel})\n集合: 8:00 JST / {date}";
const DEFAULT_CLOSE =
  ":alarm_clock: *朝活、締め切りです* ({date})\n本日の出席登録: *{count}名*";

function parseConfig(raw: string | null | undefined): Config {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? (o as Config) : {};
  } catch { return {}; }
}

function parseHm(hm: string): number | null {
  const m = HM_RE.exec(hm);
  if (!m) return null;
  const [h, min] = hm.split(":").map(Number);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

export function MorningStandupSettingsForm({
  eventId, action, onSaved,
}: { eventId: string; action: EventAction; onSaved: () => void }) {
  const toast = useToast();
  const initial = useMemo(() => parseConfig(action.config), [action.config]);
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [channelId, setChannelId] = useState(initial.channelId ?? "");
  const [channelName, setChannelName] = useState<string>("");
  const [themes, setThemes] = useState<Themes>({
    mon: initial.themes?.mon ?? "", tue: initial.themes?.tue ?? "",
    wed: initial.themes?.wed ?? "", thu: initial.themes?.thu ?? "",
    fri: initial.themes?.fri ?? "",
  });
  const [reminderTpl, setReminderTpl] = useState(initial.messageTemplates?.reminder ?? "");
  const [closeTpl, setCloseTpl] = useState(initial.messageTemplates?.close ?? "");
  const [reminderTime, setReminderTime] = useState(initial.reminderTime ?? DEFAULT_REMINDER_TIME);
  const [closeTime, setCloseTime] = useState(initial.closeTime ?? DEFAULT_CLOSE_TIME);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // workspace 一覧を取得 (1 件なら自動選択)
  useEffect(() => {
    let cancelled = false;
    api.workspaces.list()
      .then((list) => {
        if (cancelled) return;
        const ws = Array.isArray(list) ? list : [];
        setWorkspaces(ws);
        if (ws.length >= 1) setWorkspaceId(ws[0].id);
      })
      .catch(() => { if (!cancelled) setWorkspaces([]); });
    return () => { cancelled = true; };
  }, []);

  const handleSave = async () => {
    setError(null);
    const cid = channelId.trim();
    if (cid !== "" && !cid.startsWith("C")) {
      setError("正しい朝活会チャンネルを選択してください");
      return;
    }
    // PR9: 時刻バリデーション (HH:MM + 5 分単位 + reminder < close)
    const rMin = parseHm(reminderTime);
    const cMin = parseHm(closeTime);
    if (rMin == null || cMin == null) {
      setError("時刻は HH:MM 形式で入力してください");
      return;
    }
    if (rMin % 5 !== 0 || cMin % 5 !== 0) {
      setError("時刻は 5 分単位 (00, 05, 10, ...) で入力してください");
      return;
    }
    if (rMin >= cMin) {
      setError("締切時刻はリマインダー時刻より後にしてください");
      return;
    }
    const nextThemes: Partial<Themes> = {};
    for (const k of KEYS) {
      const v = themes[k].trim();
      if (v !== "") nextThemes[k] = v;
    }
    const next: Config = {
      ...initial, channelId: cid,
      reminderTime, closeTime,
    };
    if (Object.keys(nextThemes).length > 0) next.themes = nextThemes;
    else delete next.themes;

    const tpl: MessageTemplates = {};
    if (reminderTpl.trim() !== "") tpl.reminder = reminderTpl;
    if (closeTpl.trim() !== "") tpl.close = closeTpl;
    if (Object.keys(tpl).length > 0) next.messageTemplates = tpl;
    else delete next.messageTemplates;

    setSaving(true);
    try {
      await api.events.actions.update(eventId, action.id, { config: JSON.stringify(next) });
      toast.success("保存しました");
      onSaved();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "保存に失敗しました";
      setError(msg);
      toast.error(msg);
    } finally { setSaving(false); }
  };

  const showWorkspaceDropdown = workspaces !== null && workspaces.length >= 2;

  return (
    <div style={s.wrap}>
      <h3 style={{ marginTop: 0 }}>朝活リマインダー設定</h3>
      <p style={s.intro}>
        平日に朝活会チャンネルへリマインダーと締切投稿を行います。
        投稿時刻は config で変更可能 (default: 7:30 リマインダー / 8:00 締切)。
        チャンネル未選択のときは cron が skip するので「一時停止」用途にも使えます。
      </p>

      {error && <div style={s.errorBox}>{error}</div>}

      {showWorkspaceDropdown && (
        <Field label="ワークスペース">
          <select
            value={workspaceId}
            onChange={(e) => { setWorkspaceId(e.target.value); setChannelId(""); setChannelName(""); }}
            disabled={saving} aria-label="ワークスペース" style={s.input}
          >
            {workspaces!.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
        </Field>
      )}

      <Field label="朝活会チャンネル">
        {/* PR11: 初期値時 channelName 未取得でも channel ID は出さない。
            SingleChannelPicker 側で「(設定済み — 再選択で名前を確認)」と注意文を出す。 */}
        <SingleChannelPicker
          value={channelId}
          channelName={channelName}
          workspaceId={workspaceId}
          onChange={(id, name) => { setChannelId(id); setChannelName(name); }}
          disabled={saving}
        />
      </Field>

      <Field label="勉強会チーム ロール">
        <div aria-label="勉強会チーム ロール">
          <RoleNameDisplay roleId={initial.roleId ?? null} />
        </div>
        <div style={s.hint}>
          変更したい場合は「メンバー」タブ → ロール → 勉強会チーム から行ってください。
        </div>
      </Field>

      <Field label="リマインダー投稿時刻 (JST)">
        <input
          type="time" step={300} value={reminderTime}
          onChange={(e) => setReminderTime(e.target.value)}
          disabled={saving} aria-label="リマインダー投稿時刻"
          style={{ ...s.input, width: "10rem" }}
        />
        <div style={s.hint}>※ 5 分単位 (00, 05, 10, ...) 推奨。cron 粒度上 1-5 分のズレが発生します</div>
      </Field>

      <Field label="締切投稿時刻 (JST)">
        <input
          type="time" step={300} value={closeTime}
          onChange={(e) => setCloseTime(e.target.value)}
          disabled={saving} aria-label="締切投稿時刻"
          style={{ ...s.input, width: "10rem" }}
        />
      </Field>

      <Field label="曜日テーマ (空欄なら default 維持)">
        <div style={{ display: "grid", gap: "0.5rem" }}>
          {KEYS.map((k) => (
            <label key={k} style={{
              display: "grid", gridTemplateColumns: "4rem 1fr",
              alignItems: "center", gap: "0.5rem",
            }}>
              <span style={{ fontSize: "0.875rem", color: colors.text }}>{LABEL[k]}</span>
              <input
                type="text" value={themes[k]}
                onChange={(e) => setThemes((p) => ({ ...p, [k]: e.target.value }))}
                placeholder={DEFAULT_THEMES[k]} disabled={saving}
                aria-label={`${LABEL[k]}テーマ`} style={s.input}
              />
            </label>
          ))}
        </div>
      </Field>

      <Field label="リマインダー文面 (空欄なら default)">
        <textarea
          value={reminderTpl}
          onChange={(e) => setReminderTpl(e.target.value)}
          placeholder={DEFAULT_REMINDER}
          disabled={saving} rows={5}
          aria-label="リマインダー文面"
          style={{ ...s.input, fontFamily: "monospace", resize: "vertical" }}
        />
      </Field>

      <Field label="締切文面 (空欄なら default)">
        <textarea
          value={closeTpl}
          onChange={(e) => setCloseTpl(e.target.value)}
          placeholder={DEFAULT_CLOSE}
          disabled={saving} rows={3}
          aria-label="締切文面"
          style={{ ...s.input, fontFamily: "monospace", resize: "vertical" }}
        />
      </Field>

      <div style={s.tipBox}>
        <strong>💡 ヒント</strong>
        <ul style={s.tipList}>
          <li>文面で使える placeholder: <code>{"{theme}"}</code> <code>{"{dayLabel}"}</code> <code>{"{date}"}</code> <code>{"{count}"}</code> (close のみ)</li>
          <li>チャンネル未選択時は cron が skip します (一時停止に使えます)</li>
          <li>勉強会チーム ロールへのメンバー追加は メンバー → ロール → 勉強会チーム から</li>
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
