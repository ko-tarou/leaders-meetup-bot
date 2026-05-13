import { useState } from "react";
import type { CSSProperties } from "react";
import type { EventAction } from "../../types";
import { api } from "../../api";
import { useToast } from "../ui/Toast";
import { useIsReadOnly } from "../../hooks/usePublicMode";
import { colors } from "../../styles/tokens";

// 005-github-webhook: pr_review_list action の汎用設定タブ。
//
// 現状は config.githubRepo (= GitHub の "owner/repo") のみ。
// GitHub webhook が届いたとき、payload.repository.full_name と
// config.githubRepo が一致する event_action 配下の pr_reviews を更新する。
//
// 保存は events.actions.update で action.config を JSON 文字列ごと上書きする。
// 既存 config の他 key は preserve する。

const styles = {
  wrap: { padding: "1rem" } as CSSProperties,
  label: {
    display: "block",
    fontSize: "0.85rem",
    color: colors.textSecondary,
    marginBottom: "0.25rem",
  } as CSSProperties,
  input: {
    width: "min(420px, 100%)",
    padding: "0.375rem 0.5rem",
    border: `1px solid ${colors.border}`,
    borderRadius: "0.25rem",
    fontSize: "0.875rem",
    background: colors.background,
    color: colors.text,
    fontFamily: "monospace",
  } as CSSProperties,
  desc: {
    fontSize: "0.8rem",
    color: colors.textMuted,
    marginTop: "0.25rem",
  } as CSSProperties,
  btn: {
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

type Config = { githubRepo?: string; [k: string]: unknown };

function parseConfig(s: string): Config {
  try {
    const cfg = JSON.parse(s ?? "{}");
    return cfg && typeof cfg === "object" ? (cfg as Config) : {};
  } catch {
    return {};
  }
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
  const initial = parseConfig(action.config);
  const [githubRepo, setGithubRepo] = useState<string>(
    typeof initial.githubRepo === "string" ? initial.githubRepo : "",
  );
  const [saving, setSaving] = useState(false);

  const trimmed = githubRepo.trim();
  const dirty = trimmed !== (initial.githubRepo ?? "");
  // "owner/repo" 形式 (空 = 連携無効) のゆるい検証
  const formatOk =
    trimmed === "" || /^[\w.\-]+\/[\w.\-]+$/.test(trimmed);

  const handleSave = async () => {
    if (!formatOk) {
      toast.error("owner/repo 形式で入力してください (例: ko-tarou/leaders-meetup-bot)");
      return;
    }
    setSaving(true);
    try {
      const next: Config = { ...initial };
      if (trimmed === "") delete next.githubRepo;
      else next.githubRepo = trimmed;
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
      <h3 style={{ marginTop: 0 }}>GitHub 連携</h3>
      <label style={styles.label}>連携先 GitHub リポジトリ (owner/repo)</label>
      <input
        type="text"
        value={githubRepo}
        onChange={(e) => setGithubRepo(e.target.value)}
        placeholder="ko-tarou/leaders-meetup-bot"
        style={styles.input}
        disabled={isReadOnly || saving}
      />
      <div style={styles.desc}>
        このリポジトリの webhook (Pull requests / Pull request reviews) を受信して
        reviewer 割当 / LGTM / merge を board に自動反映します。空欄で無効化。
        webhook URL と secret 設定は「ワークスペース管理 → GitHub 連携」を参照。
      </div>
      {!formatOk && (
        <div
          style={{
            color: colors.danger,
            fontSize: "0.8rem",
            marginTop: "0.25rem",
          }}
        >
          owner/repo 形式で入力してください
        </div>
      )}
      <button
        type="button"
        onClick={handleSave}
        style={styles.btn}
        disabled={isReadOnly || saving || !dirty || !formatOk}
      >
        {saving ? "保存中..." : "保存"}
      </button>
    </div>
  );
}
