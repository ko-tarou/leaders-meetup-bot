import { useMemo, useState, type ReactNode } from "react";
import type { EventAction } from "../../types";
import { api } from "../../api";
import { useToast } from "../ui/Toast";
import { colors } from "../../styles/tokens";
import { settingsFormStyles as s } from "./settingsFormStyles";

// 003 PR7: morning_standup アクション専用の設定タブ。
// config schema: { channelId, roleId?, themes?: {mon..fri: string} }
// - channelId 空欄は cron が skip するので保存許可 (一時停止用途)。
// - 空でない channelId は "C" prefix を検証する。
// - themes の空欄入力は「default 維持」= omit して保存する。

type Themes = { mon: string; tue: string; wed: string; thu: string; fri: string };
type Config = { channelId?: string; roleId?: string; themes?: Partial<Themes> };

const DEFAULT_THEMES: Themes = {
  mon: "ハードウェア", tue: "フロントエンド", wed: "バックエンド",
  thu: "Android", fri: "Unity",
};
const KEYS: Array<keyof Themes> = ["mon", "tue", "wed", "thu", "fri"];
const LABEL: Record<keyof Themes, string> = {
  mon: "月曜", tue: "火曜", wed: "水曜", thu: "木曜", fri: "金曜",
};

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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const channelInvalid = channelId.trim() !== "" && !channelId.trim().startsWith("C");

  const handleSave = async () => {
    setError(null);
    const cid = channelId.trim();
    if (cid !== "" && !cid.startsWith("C")) {
      setError("channelId は Slack の channel ID (C で始まる) を入力してください");
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
        channelId が空のときは cron が skip するので「一時停止」用途にも使えます。
      </p>

      {error && <div style={s.errorBox}>{error}</div>}

      <Field label="朝活会チャンネル ID">
        <input
          type="text" value={channelId}
          onChange={(e) => setChannelId(e.target.value)}
          placeholder="C01ABC..." disabled={saving}
          aria-invalid={channelInvalid} aria-label="朝活会チャンネル ID"
          style={{ ...s.input, ...(channelInvalid ? { borderColor: colors.danger } : {}) }}
        />
      </Field>

      <Field label="勉強会チーム ロール ID">
        <input
          type="text" value={initial.roleId ?? ""} readOnly disabled
          aria-label="勉強会チーム ロール ID" placeholder="(未設定)"
          style={{ ...s.input, ...s.inputReadonly }}
        />
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

      <div style={s.tipBox}>
        <strong>💡 ヒント</strong>
        <ul style={s.tipList}>
          <li>channelId は Slack の朝活会チャンネル右クリック →「View channel details」→ 下部のID</li>
          <li>設定後、次の平日 7:30 JST から自動で投稿されます</li>
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
