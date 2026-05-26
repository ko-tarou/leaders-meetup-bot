import { useMemo, useState, type ReactNode } from "react";
import type { EventAction } from "../../types";
import { api } from "../../api";
import { useToast } from "../ui/Toast";
import { colors } from "../../styles/tokens";
import { settingsFormStyles as s } from "./settingsFormStyles";
import { ChannelSelector } from "../ChannelSelector";
import { RoleNameDisplay } from "../role-management/RoleNameDisplay";

// 003 PR7 → PR8: morning_standup アクション専用の設定タブ。
// config schema: {
//   channelId, roleId?, themes?,
//   messageTemplates?: { reminder?: string; close?: string }
// }
// - channelId 空欄は cron skip (一時停止用途)
// - PR8: channelId は ChannelSelector に置き換え (ID 直入力廃止)
// - PR8: roleId は RoleNameDisplay でロール名を表示 (config 値は維持)
// - PR8: messageTemplates 空欄は default に fallback (backend と同方針)

type Themes = { mon: string; tue: string; wed: string; thu: string; fri: string };
type MessageTemplates = { reminder?: string; close?: string };
type Config = {
  channelId?: string;
  roleId?: string;
  themes?: Partial<Themes>;
  messageTemplates?: MessageTemplates;
};

const DEFAULT_THEMES: Themes = {
  mon: "ハードウェア", tue: "フロントエンド", wed: "バックエンド",
  thu: "Android", fri: "Unity",
};
const KEYS: Array<keyof Themes> = ["mon", "tue", "wed", "thu", "fri"];
const LABEL: Record<keyof Themes, string> = {
  mon: "月曜", tue: "火曜", wed: "水曜", thu: "木曜", fri: "金曜",
};

// 003 PR8: backend (morning-standup.ts) の DEFAULT_*_TEMPLATE と同期。
// FE で文面プレビュー的に placeholder 表示する用 (空欄保存なら BE が default を使う)。
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

export function MorningStandupSettingsForm({
  eventId, action, onSaved,
}: { eventId: string; action: EventAction; onSaved: () => void }) {
  const toast = useToast();
  const initial = useMemo(() => parseConfig(action.config), [action.config]);
  const [channelId, setChannelId] = useState(initial.channelId ?? "");
  const [themes, setThemes] = useState<Themes>({
    mon: initial.themes?.mon ?? "", tue: initial.themes?.tue ?? "",
    wed: initial.themes?.wed ?? "", thu: initial.themes?.thu ?? "",
    fri: initial.themes?.fri ?? "",
  });
  const [reminderTpl, setReminderTpl] = useState(
    initial.messageTemplates?.reminder ?? "",
  );
  const [closeTpl, setCloseTpl] = useState(
    initial.messageTemplates?.close ?? "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setError(null);
    // ChannelSelector は valid な channelId しか返さないが、念のため "C" prefix 検証は維持
    const cid = channelId.trim();
    if (cid !== "" && !cid.startsWith("C")) {
      setError("channelId は Slack の channel ID (C で始まる) を指定してください");
      return;
    }
    const nextThemes: Partial<Themes> = {};
    for (const k of KEYS) {
      const v = themes[k].trim();
      if (v !== "") nextThemes[k] = v;
    }
    const next: Config = { ...initial, channelId: cid };
    if (Object.keys(nextThemes).length > 0) next.themes = nextThemes;
    else delete next.themes;

    // messageTemplates: 両方空 → 削除、片方でも値があれば指定だけ含める
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

  return (
    <div style={s.wrap}>
      <h3 style={{ marginTop: 0 }}>朝活リマインダー設定</h3>
      <p style={s.intro}>
        平日 7:30 JST に朝活会チャンネルへリマインダー、8:00 JST に締切投稿を行います。
        チャンネル未選択のときは cron が skip するので「一時停止」用途にも使えます。
      </p>

      {error && <div style={s.errorBox}>{error}</div>}

      <Field label="朝活会チャンネル">
        <ChannelSelector
          value={channelId}
          onChange={(id) => setChannelId(id)}
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

      <Field label="7:30 リマインダー文面 (空欄なら default)">
        <textarea
          value={reminderTpl}
          onChange={(e) => setReminderTpl(e.target.value)}
          placeholder={DEFAULT_REMINDER}
          disabled={saving}
          rows={5}
          aria-label="7:30 リマインダー文面"
          style={{ ...s.input, fontFamily: "monospace", resize: "vertical" }}
        />
      </Field>

      <Field label="8:00 締切文面 (空欄なら default)">
        <textarea
          value={closeTpl}
          onChange={(e) => setCloseTpl(e.target.value)}
          placeholder={DEFAULT_CLOSE}
          disabled={saving}
          rows={3}
          aria-label="8:00 締切文面"
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
