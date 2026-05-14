import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { EventAction, PRReviewListConfig } from "../../types";
import { api } from "../../api";
import { useToast } from "../ui/Toast";
import { useConfirm } from "../ui/ConfirmDialog";
import { useIsReadOnly } from "../../hooks/usePublicMode";
import { colors } from "../../styles/tokens";

// 005-github-webhook: pr_review_list action の汎用設定タブ。
//
// 1 つの action で **複数 GitHub repo** を集約管理できる。config 形式:
//   - 新: githubRepos: string[]  ←  保存はこちらのみ
//   - 旧: githubRepo: string     ←  読み込み時のみ後方互換で 1 要素配列に変換
//
// 保存は空 / 重複 (case-insensitive) / 不正形式を除外してから API に送る。
// 既存 config の他 key は preserve する。

const REPO_PATTERN = /^[\w.\-]+\/[\w.\-]+$/;

const styles = {
  wrap: { padding: "1rem" } as CSSProperties,
  label: { display: "block", fontSize: "0.85rem", color: colors.textSecondary, marginBottom: "0.5rem" } as CSSProperties,
  row: { display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.375rem" } as CSSProperties,
  input: {
    flex: 1, maxWidth: "420px", padding: "0.375rem 0.5rem",
    border: `1px solid ${colors.border}`, borderRadius: "0.25rem",
    fontSize: "0.875rem", background: colors.background, color: colors.text, fontFamily: "monospace",
  } as CSSProperties,
  removeBtn: {
    background: "transparent", color: colors.textSecondary, border: `1px solid ${colors.border}`,
    width: "2rem", height: "2rem", borderRadius: "0.25rem", cursor: "pointer", fontSize: "1rem", padding: 0,
  } as CSSProperties,
  addBtn: {
    background: "transparent", color: colors.primary, border: `1px dashed ${colors.borderStrong}`,
    padding: "0.375rem 0.75rem", borderRadius: "0.25rem", cursor: "pointer", fontSize: "0.85rem", marginTop: "0.25rem",
  } as CSSProperties,
  desc: { fontSize: "0.8rem", color: colors.textMuted, marginTop: "0.5rem" } as CSSProperties,
  errorText: { color: colors.danger, fontSize: "0.8rem", marginTop: "0.25rem" } as CSSProperties,
  saveBtn: {
    background: colors.primary, color: colors.textInverse, border: "none",
    padding: "0.5rem 1rem", borderRadius: "0.25rem", cursor: "pointer", fontSize: "0.875rem", marginTop: "0.75rem",
  } as CSSProperties,
  importSection: {
    marginTop: "1.25rem", paddingTop: "1rem", borderTop: `1px solid ${colors.border}`,
  } as CSSProperties,
  importBtn: {
    background: colors.background, color: colors.text, border: `1px solid ${colors.borderStrong}`,
    padding: "0.5rem 1rem", borderRadius: "0.25rem", cursor: "pointer", fontSize: "0.875rem",
  } as CSSProperties,
  importDesc: { fontSize: "0.8rem", color: colors.textMuted, marginTop: "0.5rem" } as CSSProperties,
};

function parseConfig(s: string): PRReviewListConfig {
  try {
    const cfg = JSON.parse(s ?? "{}");
    return cfg && typeof cfg === "object" ? (cfg as PRReviewListConfig) : {};
  } catch {
    return {};
  }
}

// 新 githubRepos / 旧 githubRepo から初期 repos[] を作る (後方互換)。
function initialReposFromConfig(cfg: PRReviewListConfig): string[] {
  if (Array.isArray(cfg.githubRepos)) {
    const list = cfg.githubRepos
      .filter((r): r is string => typeof r === "string")
      .map((r) => r.trim())
      .filter(Boolean);
    if (list.length > 0) return list;
  }
  if (typeof cfg.githubRepo === "string" && cfg.githubRepo.trim()) {
    return [cfg.githubRepo.trim()];
  }
  return [];
}

// trim + 空除外 + 重複除外 (case-insensitive)。保存前と変更検出に使う。
function normalizeRepos(repos: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of repos) {
    const t = r.trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
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
  const { confirm } = useConfirm();
  const isReadOnly = useIsReadOnly();
  const initial = useMemo(() => parseConfig(action.config), [action.config]);
  const initialRepos = useMemo(() => initialReposFromConfig(initial), [initial]);
  const [repos, setRepos] = useState<string[]>(() =>
    initialRepos.length > 0 ? initialRepos : [""],
  );
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);

  const normalized = useMemo(() => normalizeRepos(repos), [repos]);
  // 空は OK (保存時にスキップ)、それ以外は owner/repo 形式必須。
  const rowValid = repos.map((r) => r.trim() === "" || REPO_PATTERN.test(r.trim()));
  const allRowsValid = rowValid.every(Boolean);
  const dirty =
    normalized.length !== initialRepos.length ||
    normalized.some((r, i) => r !== initialRepos[i]);

  // 005-github-import: 設定済み repo の open PR を取り込む。
  // 取り込み対象は **保存済み** の repos (config.githubRepos)。未保存の編集中
  // 入力は対象外。理由: BE は action.config を読むので、編集中入力が反映され
  // ていない時点で取り込むと「画面と挙動の乖離」が起きる。dirty 時は警告。
  const handleImport = async () => {
    if (initialRepos.length === 0) {
      toast.error("GitHub repo を 1 つ以上設定してください");
      return;
    }
    if (dirty) {
      toast.error("未保存の変更があります。先に保存してください");
      return;
    }
    const ok = await confirm({
      message: `${initialRepos.length} 個の repo から open PR を取り込みます。よろしいですか？`,
      confirmLabel: "取り込み",
    });
    if (!ok) return;

    setImporting(true);
    try {
      const res = await api.prReviews.importGitHubPRs(eventId, action.id);
      const failed = res.results.filter((r) => !r.ok);
      const parts = [
        `新規 ${res.totalImported}件`,
        `更新 ${res.totalUpdated}件`,
        `担当追加 ${res.totalReviewers}件`,
        `LGTM ${res.totalLgtms}件`,
      ];
      if (failed.length > 0) {
        toast.error(
          `一部失敗 (${failed.length}/${res.results.length} repo): ${failed
            .map((f) => `${f.repo} (${f.error ?? "error"})`)
            .join(", ")}`,
        );
      } else {
        toast.success(`取り込み完了: ${parts.join(" / ")}`);
      }
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "取り込みに失敗しました");
    } finally {
      setImporting(false);
    }
  };

  const handleSave = async () => {
    if (!allRowsValid) {
      toast.error("owner/repo 形式で入力してください (例: ko-tarou/leaders-meetup-bot)");
      return;
    }
    setSaving(true);
    try {
      const next: PRReviewListConfig = { ...initial };
      if (normalized.length === 0) delete next.githubRepos;
      else next.githubRepos = normalized;
      // 旧 single key は新形式が入った時点で削除 (両方残すと混乱の元)。
      delete next.githubRepo;
      await api.events.actions.update(eventId, action.id, { config: JSON.stringify(next) });
      toast.success("保存しました");
      setRepos(normalized.length > 0 ? normalized : [""]);
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
      <label style={styles.label}>連携先 GitHub リポジトリ (owner/repo) — 複数登録可</label>
      {repos.map((value, i) => (
        <div key={i} style={styles.row}>
          <input
            type="text"
            value={value}
            onChange={(e) =>
              setRepos((prev) => prev.map((r, idx) => (idx === i ? e.target.value : r)))
            }
            placeholder="ko-tarou/leaders-meetup-bot"
            style={{
              ...styles.input,
              ...(rowValid[i] ? {} : { borderColor: colors.danger }),
            }}
            disabled={isReadOnly || saving}
            aria-label={`GitHub repo ${i + 1}`}
            aria-invalid={!rowValid[i]}
          />
          <button
            type="button"
            onClick={() =>
              setRepos((prev) => {
                const next = prev.filter((_, idx) => idx !== i);
                return next.length > 0 ? next : [""];
              })
            }
            style={styles.removeBtn}
            disabled={isReadOnly || saving}
            aria-label={`${i + 1} 行目を削除`}
            title="この repo を削除"
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => setRepos((prev) => [...prev, ""])}
        style={styles.addBtn}
        disabled={isReadOnly || saving}
      >
        + repo を追加
      </button>
      <div style={styles.desc}>
        これらのリポジトリの webhook (Pull requests / Pull request reviews) を受信して、
        reviewer 割当 / LGTM / merge を board に自動反映します。全削除で連携を無効化できます。
        webhook URL と secret 設定は「ワークスペース管理 → GitHub 連携」を参照。
      </div>
      {!allRowsValid && (
        <div style={styles.errorText}>
          owner/repo 形式で入力してください (空欄は保存時にスキップされます)
        </div>
      )}
      <button
        type="button"
        onClick={handleSave}
        style={styles.saveBtn}
        disabled={isReadOnly || saving || !dirty || !allRowsValid}
      >
        {saving ? "保存中..." : "保存"}
      </button>

      <div style={styles.importSection}>
        <button
          type="button"
          onClick={handleImport}
          style={styles.importBtn}
          disabled={
            isReadOnly || importing || saving || initialRepos.length === 0 || dirty
          }
          title={
            initialRepos.length === 0
              ? "GitHub repo を保存してから取り込めます"
              : dirty
                ? "未保存の変更があります。先に保存してください"
                : undefined
          }
        >
          {importing ? "取り込み中..." : "Open PR を取り込み"}
        </button>
        <div style={styles.importDesc}>
          設定済みリポジトリの open PR と requested reviewers / 既存 LGTM を一括で
          board に同期します。webhook 未到来の進行中 PR を取り込むためのもの。
          GitHub API は未認証 (60 req/hour) で叩くので public repo のみ対応。
        </div>
      </div>
    </div>
  );
}
