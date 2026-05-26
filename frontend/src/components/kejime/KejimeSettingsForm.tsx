import { useMemo, useState, type ReactNode } from "react";
import type { EventAction } from "../../types";
import { api } from "../../api";
import { useToast } from "../ui/Toast";
import { colors } from "../../styles/tokens";
import { settingsFormStyles as s } from "../morning-standup/settingsFormStyles";

// 003 PR7: kejime_tracker アクション専用の設定タブ。
// config schema: { kejimeChannelId, roleId?, minArticleLength? }
// - kejimeChannelId 空欄は cron skip / 空でないなら "C" prefix を要求。
// - minArticleLength は 1 以上の整数を要求 (0 / 負数 / 非整数は弾く)。

type Config = { kejimeChannelId?: string; roleId?: string; minArticleLength?: number };

const DEFAULT_MIN = 500;

function parseConfig(raw: string | null | undefined): Config {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? (o as Config) : {};
  } catch { return {}; }
}

export function KejimeSettingsForm({
  eventId, action, onSaved,
}: { eventId: string; action: EventAction; onSaved: () => void }) {
  const toast = useToast();
  const initial = useMemo(() => parseConfig(action.config), [action.config]);
  const [kejimeChannelId, setKejimeChannelId] = useState(initial.kejimeChannelId ?? "");
  const [minArticleLength, setMinArticleLength] = useState(
    String(initial.minArticleLength ?? DEFAULT_MIN),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const channelInvalid =
    kejimeChannelId.trim() !== "" && !kejimeChannelId.trim().startsWith("C");
  const minParsed = Number(minArticleLength);
  const minInvalid =
    minArticleLength.trim() === "" || !Number.isInteger(minParsed) || minParsed < 1;

  const handleSave = async () => {
    setError(null);
    const cid = kejimeChannelId.trim();
    if (cid !== "" && !cid.startsWith("C")) {
      setError("kejimeChannelId は Slack の channel ID (C で始まる) を入力してください");
      return;
    }
    if (minInvalid) {
      setError("記事の最小文字数は 1 以上の整数で入力してください");
      return;
    }
    const next: Config = { ...initial, kejimeChannelId: cid, minArticleLength: minParsed };

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
      <h3 style={{ marginTop: 0 }}>けじめ管理 設定</h3>
      <p style={s.intro}>
        けじめチャンネルへの記事 URL 申請 / 遅刻ステータス自動再投稿 / いいね承認の設定です。
        kejimeChannelId が空のときは cron が skip します。
      </p>

      {error && <div style={s.errorBox}>{error}</div>}

      <Field label="けじめチャンネル ID">
        <input
          type="text" value={kejimeChannelId}
          onChange={(e) => setKejimeChannelId(e.target.value)}
          placeholder="C01ABC..." disabled={saving}
          aria-invalid={channelInvalid} aria-label="けじめチャンネル ID"
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

      <Field label="記事の最小文字数">
        <input
          type="number" min={1} step={1} value={minArticleLength}
          onChange={(e) => setMinArticleLength(e.target.value)}
          disabled={saving} aria-invalid={minInvalid} aria-label="記事の最小文字数"
          style={{
            ...s.input, width: "10rem",
            ...(minInvalid ? { borderColor: colors.danger } : {}),
          }}
        />
        <div style={s.hint}>
          default は {DEFAULT_MIN}。これ未満の記事は自動却下されます。
        </div>
      </Field>

      <div style={s.tipBox}>
        <strong>💡 ヒント</strong>
        <ul style={s.tipList}>
          <li>kejimeChannelId はけじめチャンネルの ID (C で始まる)</li>
          <li>記事は Qiita のみ受付 (https://qiita.com/&lt;user&gt;/items/&lt;id&gt;)</li>
          <li>「勉強会チーム」のいいねリアクションで承認 (自分自身は不可)</li>
          <li>{DEFAULT_MIN}文字未満は自動却下</li>
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
