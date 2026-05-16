import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { EventAction, PRReviewListConfig } from "../../types";
import { api } from "../../api";
import { useToast } from "../ui/Toast";
import { useIsReadOnly } from "../../hooks/usePublicMode";
import { colors } from "../../styles/tokens";

// pr_review_list action の汎用設定タブ。
//
// PR レビューは Slack で完結する設計。レビュアー指定 / LGTM / 再レビューは
// Slack の sticky board 上で行うため、ここで設定するのは
// 「自動完了に必要な LGTM 数 (しきい値)」のみ。
//
// config は JSON 文字列。保存時は既存 config の他 key を温存し
// (NotificationsTab 等と同じマージ作法)、lgtmThreshold のみ差し替える。

const DEFAULT_LGTM_THRESHOLD = 2;

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
  } as CSSProperties,
  input: {
    width: "8rem",
    padding: "0.375rem 0.5rem",
    border: `1px solid ${colors.border}`,
    borderRadius: "0.25rem",
    fontSize: "0.875rem",
    background: colors.background,
    color: colors.text,
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
  saveBtn: {
    background: colors.primary,
    color: colors.textInverse,
    border: "none",
    padding: "0.5rem 1rem",
    borderRadius: "0.25rem",
    cursor: "pointer",
    fontSize: "0.875rem",
    marginTop: "0.75rem",
  } as CSSProperties,
};

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

  const parsed = Number(threshold);
  const valid =
    threshold.trim() !== "" &&
    Number.isInteger(parsed) &&
    parsed >= 1;
  const dirty = valid && parsed !== initialValue;

  const handleSave = async () => {
    if (!valid) {
      toast.error("LGTM 必要数は 1 以上の整数で入力してください");
      return;
    }
    setSaving(true);
    try {
      // 他 config key を温存したまま lgtmThreshold のみ差し替える
      // (NotificationsTab 等と同じマージ保存作法)。
      const next: PRReviewListConfig = { ...initial, lgtmThreshold: parsed };
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

  return (
    <div style={styles.wrap}>
      <h3 style={{ marginTop: 0 }}>PR レビュー設定</h3>
      <p style={styles.intro}>
        PR レビューは Slack で完結します。レビュアー指定・LGTM・再レビューは
        Slack の sticky board 上で行います。ここでは自動完了に必要な LGTM
        数（しきい値）のみ設定します。
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
        <div style={styles.errorText}>
          1 以上の整数で入力してください
        </div>
      )}

      <div>
        <button
          type="button"
          onClick={handleSave}
          style={styles.saveBtn}
          disabled={isReadOnly || saving || !dirty || !valid}
        >
          {saving ? "保存中..." : "保存"}
        </button>
      </div>
    </div>
  );
}
