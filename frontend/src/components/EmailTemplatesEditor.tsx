import { useEffect, useState } from "react";
import type {
  AutoSendEmailConfig,
  EmailTemplate,
  EventAction,
  GmailAccount,
  SlackInvite,
} from "../types";
import { api } from "../api";
import { colors } from "../styles/tokens";
import { LogToSlackSection } from "./email-templates/LogToSlackSection";
import { SlackInvitesSection } from "./email-templates/SlackInvitesSection";
import {
  DEFAULT_TEMPLATES,
  TRIGGER_DEFS,
  genId,
  parseInitialAutoSend,
  parseInitialSlackInvites,
  parseInitialTemplates,
} from "./email-templates/parsers";
import { styles } from "./email-templates/styles";

// Sprint 24: 管理画面 (member_application > メール サブタブ) で使う。
// event_actions.config.emailTemplates に複数テンプレを保存する。
// 応募詳細モーダルの select はここで保存されたテンプレ一覧から選ぶ。
//
// 既存 config の他フィールド (leaderAvailableSlots 等) は壊さないよう
// JSON をパース → emailTemplates だけ差し替え → JSON.stringify で保存する。
//
// Phase4-4: parser / 定数 / styles / LogToSlackSection を
// ./email-templates/ 配下へ純抽出 (振る舞い不変)。

type Props = {
  eventId: string;
  action: EventAction;
  onChange: () => void;
};

export function EmailTemplatesEditor({ eventId, action, onChange }: Props) {
  const [templates, setTemplates] = useState<EmailTemplate[]>(() =>
    parseInitialTemplates(action.config),
  );
  // Sprint 26: 自動送信設定。templates と同じ「保存」ボタンでまとめて永続化する。
  const [autoSend, setAutoSend] = useState<AutoSendEmailConfig>(() =>
    parseInitialAutoSend(action.config),
  );
  const [gmailAccounts, setGmailAccounts] = useState<GmailAccount[]>([]);
  const [gmailAccountsLoaded, setGmailAccountsLoaded] = useState(false);
  // 005-slack-invite-monitor: Slack 招待リンク (複数登録対応)。
  // 配列で保持し、templates と同じ「保存」ボタンで永続化する。
  const [slackInvites, setSlackInvites] = useState<SlackInvite[]>(() =>
    parseInitialSlackInvites(action.config),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.gmailAccounts
      .list()
      .then((list) => {
        if (cancelled) return;
        setGmailAccounts(list);
        setGmailAccountsLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        // 失敗しても editor 自体は動かせるよう、エラー表示はしない
        setGmailAccountsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateAt = (idx: number, patch: Partial<EmailTemplate>) => {
    setTemplates((prev) =>
      prev.map((t, i) => (i === idx ? { ...t, ...patch } : t)),
    );
  };

  const removeAt = (idx: number) => {
    setTemplates((prev) => prev.filter((_, i) => i !== idx));
  };

  const moveUp = (idx: number) => {
    if (idx <= 0) return;
    setTemplates((prev) => {
      const next = [...prev];
      [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
      return next;
    });
  };

  const moveDown = (idx: number) => {
    setTemplates((prev) => {
      if (idx >= prev.length - 1) return prev;
      const next = [...prev];
      [next[idx + 1], next[idx]] = [next[idx], next[idx + 1]];
      return next;
    });
  };

  const addEmpty = () => {
    setTemplates((prev) => [
      ...prev,
      { id: genId(), name: "", subject: "", body: "" },
    ]);
  };

  const addDefaults = () => {
    setTemplates((prev) => [
      ...prev,
      ...DEFAULT_TEMPLATES.map((t) => ({ ...t, id: genId() })),
    ]);
  };

  const handleSave = async () => {
    setError(null);
    setSavedAt(null);

    // バリデーション: name と body の空チェック
    const blankIdx = templates.findIndex(
      (t) => t.name.trim() === "" || t.body.trim() === "",
    );
    if (blankIdx >= 0) {
      setError(
        `${blankIdx + 1} 番目のテンプレでテンプレ名または本文が空です。`,
      );
      return;
    }

    // 005-slack-invite-monitor: 各 invite 単位で監視 enabled なら必須項目チェック。
    for (let i = 0; i < slackInvites.length; i++) {
      const inv = slackInvites[i];
      if (!inv.monitorEnabled) continue;
      const label = inv.name?.trim() || `招待リンク #${i + 1}`;
      if (!inv.url || !inv.url.trim()) {
        setError(`「${label}」: 監視が有効ですが、招待リンク URL が未入力です。`);
        return;
      }
      if (!inv.monitorWorkspaceId) {
        setError(`「${label}」: 監視: 通知先ワークスペースが未選択です。`);
        return;
      }
      if (!inv.monitorChannelId) {
        setError(`「${label}」: 監視: 通知先チャンネルが未選択です。`);
        return;
      }
    }

    // Sprint 26 + 005-meet: 自動送信が enabled なら必須項目をチェック。
    // - Gmail アカウントは必須。
    // - 少なくとも 1 trigger に template id が設定されていること。
    // - 設定された template id は templates 中に存在すること。
    if (autoSend.enabled) {
      if (!autoSend.gmailAccountId) {
        setError("自動送信が有効ですが、Gmail アカウントが未選択です。");
        return;
      }
      const triggers = autoSend.triggers ?? {};
      const selectedIds = TRIGGER_DEFS.map((d) => triggers[d.key]).filter(
        (v): v is string => typeof v === "string" && v.length > 0,
      );
      if (selectedIds.length === 0) {
        setError(
          "自動送信が有効ですが、トリガーが 1 つも選択されていません。少なくとも 1 つ選択してください。",
        );
        return;
      }
      const missing = selectedIds.find(
        (id) => !templates.some((t) => t.id === id),
      );
      if (missing) {
        setError(
          "選択されたトリガーのテンプレートが存在しません。再選択してから保存してください。",
        );
        return;
      }
    }

    // Slack ログ通知 (任意): 有効化されているなら workspace / channel 必須。
    const logCfg = autoSend.logToSlack;
    if (logCfg?.enabled) {
      if (!logCfg.workspaceId) {
        setError("Slack ログ通知が有効ですが、ワークスペースが未選択です。");
        return;
      }
      if (!logCfg.channelId) {
        setError("Slack ログ通知が有効ですが、通知先チャンネルが未選択です。");
        return;
      }
    }

    setSubmitting(true);
    try {
      // 既存 config の他フィールド (leaderAvailableSlots 等) を保持してマージ
      let cfg: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(action.config || "{}");
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          !Array.isArray(parsed)
        ) {
          cfg = parsed as Record<string, unknown>;
        }
      } catch {
        cfg = {};
      }
      cfg.emailTemplates = templates;
      // Sprint 26 + 005-meet: 自動送信設定。trigger 形式で保存し、旧 templateId は捨てる。
      // 未選択 trigger は object から削除して JSON を小さく保つ。
      const triggersOut: Record<string, string> = {};
      for (const def of TRIGGER_DEFS) {
        const v = autoSend.triggers?.[def.key];
        if (v) triggersOut[def.key] = v;
      }
      // logToSlack: enabled=false でも設定値は維持する (UI 再表示用)。
      // 未設定 (undefined) なら保存しない。
      const logOut = autoSend.logToSlack;
      cfg.autoSendEmail = {
        enabled: !!autoSend.enabled,
        gmailAccountId: autoSend.gmailAccountId,
        triggers: triggersOut,
        ...(autoSend.replyToEmail && autoSend.replyToEmail.trim()
          ? { replyToEmail: autoSend.replyToEmail.trim() }
          : {}),
        ...(logOut ? { logToSlack: logOut } : {}),
      };

      // 005-slack-invite-monitor: slackInvites (配列) を merge 保存。
      // BE が cron で書き換える運用フィールド (lastCheckedAt / lastStatus / lastNotifiedAt) は
      // FE で触らず保持する。state 自体が「初期 parse 値 + ユーザー編集」なので、
      // 編集 UI に出ていない運用フィールドはそのまま残る。
      //
      // 旧 slackInvite (単数) キーは parse 時に slackInvites へ統合済み。保存時は削除する。
      const cleanedInvites = slackInvites.map((inv) => {
        const out: Record<string, unknown> = {
          id: inv.id,
          name: (inv.name ?? "").trim(),
          url: (inv.url ?? "").trim() || undefined,
          monitorEnabled: !!inv.monitorEnabled,
        };
        // 運用フィールドは保持 (BE cron が書き込んだ値)
        if (inv.lastCheckedAt) out.lastCheckedAt = inv.lastCheckedAt;
        if (inv.lastStatus) out.lastStatus = inv.lastStatus;
        if (inv.lastNotifiedAt) out.lastNotifiedAt = inv.lastNotifiedAt;
        if (inv.monitorEnabled) {
          out.monitorWorkspaceId = inv.monitorWorkspaceId;
          out.monitorChannelId = inv.monitorChannelId;
          if (inv.monitorChannelName) {
            out.monitorChannelName = inv.monitorChannelName;
          }
          out.monitorMentionUserIds = inv.monitorMentionUserIds ?? [];
        }
        return out;
      });
      cfg.slackInvites = cleanedInvites;
      // 旧 single key は削除 (正規形のみ保持)
      if ("slackInvite" in cfg) {
        delete cfg.slackInvite;
      }

      await api.events.actions.update(eventId, action.id, {
        config: JSON.stringify(cfg),
      });
      setSavedAt(new Date().toISOString());
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={styles.container}>
      <h3 style={{ marginTop: 0 }}>メールテンプレート管理</h3>
      <p style={styles.description}>
        応募者へのメールテンプレートを管理します。
        応募詳細画面の「メールテンプレ」欄から選択して使えます。
      </p>
      <div style={styles.helpBox}>
        <strong>プレースホルダ:</strong>{" "}
        <code>{"{name}"}</code> / <code>{"{email}"}</code> /{" "}
        <code>{"{studentId}"}</code> / <code>{"{interviewAt}"}</code> /{" "}
        <code>{"{meetLink}"}</code> / <code>{"{slackInviteLink}"}</code>
        <div style={styles.helpHint}>
          (送信時に応募者の値で置換されます。{"{meetLink}"}{" "}
          は「面接予定時」トリガーで自動生成された Google Meet URL が入ります。
          {"{slackInviteLink}"} は下の「Slack 招待リンク」セクションに登録した
          URL が入ります)
        </div>
      </div>

      {/* Sprint 26: 応募成功時の Gmail 自動送信設定 */}
      <div style={styles.autoSendBox}>
        <div style={styles.autoSendHeader}>
          <strong>自動送信設定</strong>
          <label style={styles.toggleLabel}>
            <input
              type="checkbox"
              checked={!!autoSend.enabled}
              onChange={(e) =>
                setAutoSend((prev) => ({ ...prev, enabled: e.target.checked }))
              }
              disabled={submitting}
            />
            <span>有効化</span>
          </label>
        </div>
        <p style={styles.helpHint}>
          応募が完了した瞬間に、選択した Gmail から応募者へテンプレを自動送信します。失敗しても応募自体は成功します。
        </p>

        <div style={styles.autoSendRow}>
          <label style={styles.autoSendLabel}>Gmail アカウント</label>
          <select
            value={autoSend.gmailAccountId ?? ""}
            onChange={(e) =>
              setAutoSend((prev) => ({
                ...prev,
                gmailAccountId: e.target.value || undefined,
              }))
            }
            disabled={submitting}
            style={styles.select}
          >
            <option value="">
              {gmailAccountsLoaded
                ? gmailAccounts.length === 0
                  ? "（未連携 — ワークスペース管理から連携してください）"
                  : "（選択してください）"
                : "読み込み中..."}
            </option>
            {gmailAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.email}
              </option>
            ))}
          </select>
        </div>

        {/* 005-meet: trigger 別の template 選択 (応募完了時 / 面接予定時 / 合格時 / 不合格時) */}
        <div style={styles.triggersGroup}>
          <div style={styles.triggersTitle}>送信トリガー</div>
          {TRIGGER_DEFS.map((def) => {
            const value = autoSend.triggers?.[def.key] ?? "";
            return (
              <div key={def.key} style={styles.triggerRow}>
                <div style={styles.triggerLabelBlock}>
                  <div style={styles.triggerLabel}>{def.label}</div>
                  <div style={styles.triggerDescription}>{def.description}</div>
                </div>
                <select
                  value={value}
                  onChange={(e) =>
                    setAutoSend((prev) => ({
                      ...prev,
                      triggers: {
                        ...(prev.triggers ?? {}),
                        [def.key]: e.target.value || undefined,
                      },
                    }))
                  }
                  disabled={submitting || templates.length === 0}
                  style={styles.select}
                >
                  <option value="">
                    {templates.length === 0
                      ? "（テンプレ未登録）"
                      : "送信しない"}
                  </option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name || "(無名テンプレ)"}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>

        <div style={styles.autoSendRow}>
          <label style={styles.autoSendLabel}>Reply-To (任意)</label>
          <input
            type="email"
            value={autoSend.replyToEmail ?? ""}
            onChange={(e) =>
              setAutoSend((prev) => ({
                ...prev,
                replyToEmail: e.target.value,
              }))
            }
            placeholder="返信先メールアドレス (空欄なら Gmail アカウントが受信)"
            disabled={submitting}
            style={styles.select}
          />
        </div>
      </div>

      {/* 自動送信成功時の Slack ログ通知 (任意セクション) */}
      <LogToSlackSection
        value={autoSend.logToSlack}
        onChange={(next) =>
          setAutoSend((prev) => ({ ...prev, logToSlack: next }))
        }
        disabled={submitting}
      />

      {/* 005-slack-invite-monitor: Slack 招待リンク (複数登録対応) + 1 日 1 回の有効性監視 */}
      <SlackInvitesSection
        value={slackInvites}
        onChange={setSlackInvites}
        disabled={submitting}
      />

      {error && (
        <div role="alert" style={styles.error}>
          {error}
        </div>
      )}

      {templates.length === 0 ? (
        <div style={styles.empty}>テンプレが登録されていません</div>
      ) : (
        <div style={{ display: "grid", gap: "0.75rem" }}>
          {templates.map((t, i) => (
            <div key={t.id} style={styles.card}>
              <div style={styles.cardHeader}>
                <input
                  type="text"
                  value={t.name}
                  onChange={(e) => updateAt(i, { name: e.target.value })}
                  placeholder="テンプレ名（例: 最初の連絡）"
                  style={styles.nameInput}
                  disabled={submitting}
                />
                <div style={styles.cardActions}>
                  <button
                    type="button"
                    onClick={() => moveUp(i)}
                    disabled={i === 0 || submitting}
                    style={styles.iconBtn}
                    title="上へ"
                    aria-label="上へ"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => moveDown(i)}
                    disabled={i === templates.length - 1 || submitting}
                    style={styles.iconBtn}
                    title="下へ"
                    aria-label="下へ"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => removeAt(i)}
                    disabled={submitting}
                    style={{ ...styles.iconBtn, ...styles.deleteIconBtn }}
                    title="削除"
                    aria-label="削除"
                  >
                    ×
                  </button>
                </div>
              </div>
              <input
                type="text"
                value={t.subject ?? ""}
                onChange={(e) => updateAt(i, { subject: e.target.value })}
                placeholder="件名（プレースホルダ可、未入力なら『ご応募ありがとうございます』）"
                style={styles.subjectInput}
                disabled={submitting}
              />
              <textarea
                value={t.body}
                onChange={(e) => updateAt(i, { body: e.target.value })}
                rows={8}
                placeholder="本文（プレースホルダ可）"
                style={styles.bodyArea}
                disabled={submitting}
              />
            </div>
          ))}
        </div>
      )}

      <div style={styles.buttonRow}>
        <button
          type="button"
          onClick={addEmpty}
          disabled={submitting}
          style={styles.secondaryBtn}
        >
          + テンプレを追加
        </button>
        <button
          type="button"
          onClick={addDefaults}
          disabled={submitting}
          style={styles.secondaryBtn}
          title="面談確定 / 合格 / 不合格の 3 種をまとめて追加します"
        >
          デフォルトテンプレ例を追加
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={submitting}
          style={styles.primaryBtn}
        >
          {submitting ? "保存中..." : "保存"}
        </button>
        {savedAt && (
          <span style={{ fontSize: "0.875rem", color: colors.success }}>
            ✓ 保存しました
          </span>
        )}
      </div>
    </div>
  );
}
