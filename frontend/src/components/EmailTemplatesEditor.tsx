import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type {
  AutoSendEmailConfig,
  EmailTemplate,
  EventAction,
  GmailAccount,
} from "../types";
import { api } from "../api";
import { colors } from "../styles/tokens";

// Sprint 24: 管理画面 (member_application > メール サブタブ) で使う。
// event_actions.config.emailTemplates に複数テンプレを保存する。
// 応募詳細モーダルの select はここで保存されたテンプレ一覧から選ぶ。
//
// 既存 config の他フィールド (leaderAvailableSlots 等) は壊さないよう
// JSON をパース → emailTemplates だけ差し替え → JSON.stringify で保存する。

type Props = {
  eventId: string;
  action: EventAction;
  onChange: () => void;
};

// kota の初期セットアップ補助。「デフォルトテンプレ例を追加」ボタンで一発で
// 旧 hardcoded 3 種を復元できる。
const DEFAULT_TEMPLATES: ReadonlyArray<Omit<EmailTemplate, "id">> = [
  {
    name: "面談確定の連絡",
    subject: "【DevelopersHub】面談日時のご連絡",
    body: `{name} 様

ご応募ありがとうございました。
面談日時を以下に設定させていただきました。

日時: {interviewAt}
場所: [Google Meet / Zoom URL]

ご都合つかない場合はご返信ください。

よろしくお願いいたします。`,
  },
  {
    name: "合格通知",
    subject: "【DevelopersHub】合格のご連絡",
    body: `{name} 様

面談ありがとうございました。
合格となりましたので、ご連絡いたします。

[次のステップを記載]

よろしくお願いいたします。`,
  },
  {
    name: "不合格通知",
    subject: "【DevelopersHub】選考結果のご連絡",
    body: `{name} 様

面談ありがとうございました。
慎重に検討させていただいた結果、今回はご縁がなかったとさせていただきます。

ご応募いただきありがとうございました。
今後ともよろしくお願いいたします。`,
  },
];

function parseInitialTemplates(
  configRaw: string | null | undefined,
): EmailTemplate[] {
  try {
    const cfg = JSON.parse(configRaw || "{}");
    if (cfg && Array.isArray(cfg.emailTemplates)) {
      return cfg.emailTemplates
        .filter(
          (t: unknown): t is EmailTemplate =>
            typeof t === "object" &&
            t !== null &&
            typeof (t as EmailTemplate).id === "string" &&
            typeof (t as EmailTemplate).name === "string" &&
            typeof (t as EmailTemplate).body === "string",
        )
        .map((t: EmailTemplate) => ({
          id: t.id,
          name: t.name,
          // Sprint 26: subject は optional。古いレコードには無いので undefined のまま残す。
          subject: typeof t.subject === "string" ? t.subject : undefined,
          body: t.body,
        }));
    }
    return [];
  } catch {
    return [];
  }
}

// Sprint 26: action.config.autoSendEmail を取り出す。
// 不正な JSON や欠損は空オブジェクト ({} = 自動送信無効) を返す。
//
// 005-meet: triggers 形式に正規化する。旧 templateId のみの設定は
//   triggers.onSubmit へ移行 (BE と同じ fallback ルール)。
function parseInitialAutoSend(
  configRaw: string | null | undefined,
): AutoSendEmailConfig {
  try {
    const cfg = JSON.parse(configRaw || "{}");
    const raw = (cfg as { autoSendEmail?: AutoSendEmailConfig })
      .autoSendEmail;
    if (!raw || typeof raw !== "object") return {};
    const triggersRaw = (raw.triggers && typeof raw.triggers === "object"
      ? raw.triggers
      : {}) as AutoSendEmailConfig["triggers"];
    const legacyTemplateId =
      typeof raw.templateId === "string" ? raw.templateId : undefined;
    const triggers = {
      // 旧 templateId は onSubmit に fallback (UI ロードのみ。保存時は新形式へ統一)。
      onSubmit:
        typeof triggersRaw?.onSubmit === "string"
          ? triggersRaw.onSubmit
          : legacyTemplateId,
      onScheduled:
        typeof triggersRaw?.onScheduled === "string"
          ? triggersRaw.onScheduled
          : undefined,
      onPassed:
        typeof triggersRaw?.onPassed === "string"
          ? triggersRaw.onPassed
          : undefined,
    };
    return {
      enabled: !!raw.enabled,
      gmailAccountId:
        typeof raw.gmailAccountId === "string" ? raw.gmailAccountId : undefined,
      replyToEmail:
        typeof raw.replyToEmail === "string" ? raw.replyToEmail : undefined,
      triggers,
    };
  } catch {
    return {};
  }
}

// 005-meet: trigger ラベル + UI 順序定義。
// 編集 UI と「保存時のバリデーション」両方で参照する。
const TRIGGER_DEFS: ReadonlyArray<{
  key: "onSubmit" | "onScheduled" | "onPassed";
  label: string;
  description: string;
}> = [
  {
    key: "onSubmit",
    label: "応募完了時",
    description: "公開フォームからの応募作成が成功した直後に送信",
  },
  {
    key: "onScheduled",
    label: "面接予定時",
    description:
      "status: pending → scheduled で送信。Google Meet link を自動生成し {meetLink} に埋め込み",
  },
  {
    key: "onPassed",
    label: "合格時",
    description: "status: → passed で送信",
  },
];

function genId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  // フォールバック (古い WebView / SSR 環境)
  return `tpl_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

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
      cfg.autoSendEmail = {
        enabled: !!autoSend.enabled,
        gmailAccountId: autoSend.gmailAccountId,
        triggers: triggersOut,
        ...(autoSend.replyToEmail && autoSend.replyToEmail.trim()
          ? { replyToEmail: autoSend.replyToEmail.trim() }
          : {}),
      };
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
        <code>{"{meetLink}"}</code>
        <div style={styles.helpHint}>
          (送信時に応募者の値で置換されます。{"{meetLink}"}{" "}
          は「面接予定時」トリガーで自動生成された Google Meet URL が入ります)
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

        {/* 005-meet: trigger 別の template 選択 (応募完了時 / 面接予定時 / 合格時) */}
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

const styles = {
  container: { padding: "1rem" } as CSSProperties,
  description: {
    color: colors.textSecondary,
    fontSize: "0.875rem",
    marginTop: 0,
    marginBottom: "0.5rem",
  } as CSSProperties,
  helpBox: {
    background: colors.surface,
    border: `1px solid ${colors.border}`,
    borderRadius: "0.375rem",
    padding: "0.5rem 0.75rem",
    fontSize: "0.8125rem",
    marginBottom: "1rem",
  } as CSSProperties,
  helpHint: {
    color: colors.textSecondary,
    fontSize: "0.75rem",
    marginTop: "0.25rem",
  } as CSSProperties,
  error: {
    color: colors.danger,
    background: colors.dangerSubtle,
    border: `1px solid ${colors.dangerSubtle}`,
    borderRadius: "0.25rem",
    padding: "0.5rem 0.75rem",
    marginBottom: "0.75rem",
    fontSize: "0.875rem",
  } as CSSProperties,
  empty: {
    padding: "1.5rem",
    textAlign: "center",
    color: colors.textSecondary,
    border: `1px dashed ${colors.borderStrong}`,
    borderRadius: "0.5rem",
    marginBottom: "0.75rem",
  } as CSSProperties,
  card: {
    border: `1px solid ${colors.border}`,
    borderRadius: "0.375rem",
    padding: "0.75rem",
    background: colors.background,
  } as CSSProperties,
  cardHeader: {
    display: "flex",
    gap: "0.5rem",
    alignItems: "center",
    marginBottom: "0.5rem",
  } as CSSProperties,
  cardActions: {
    display: "flex",
    gap: "0.25rem",
    flexShrink: 0,
  } as CSSProperties,
  nameInput: {
    flex: 1,
    padding: "0.375rem 0.5rem",
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: "0.25rem",
    fontSize: "0.875rem",
  } as CSSProperties,
  subjectInput: {
    width: "100%",
    padding: "0.375rem 0.5rem",
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: "0.25rem",
    fontSize: "0.8125rem",
    marginBottom: "0.5rem",
    boxSizing: "border-box",
  } as CSSProperties,
  autoSendBox: {
    background: colors.surface,
    border: `1px solid ${colors.border}`,
    borderRadius: "0.375rem",
    padding: "0.75rem 1rem",
    marginBottom: "1rem",
  } as CSSProperties,
  autoSendHeader: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    marginBottom: "0.25rem",
  } as CSSProperties,
  toggleLabel: {
    marginLeft: "auto",
    display: "flex",
    alignItems: "center",
    gap: "0.25rem",
    fontSize: "0.875rem",
    cursor: "pointer",
  } as CSSProperties,
  autoSendRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    marginTop: "0.5rem",
  } as CSSProperties,
  autoSendLabel: {
    minWidth: "9rem",
    fontSize: "0.8125rem",
    color: colors.textSecondary,
  } as CSSProperties,
  triggersGroup: {
    marginTop: "0.75rem",
    paddingTop: "0.5rem",
    borderTop: `1px dashed ${colors.border}`,
  } as CSSProperties,
  triggersTitle: {
    fontSize: "0.8125rem",
    fontWeight: 600,
    color: colors.textSecondary,
    marginBottom: "0.25rem",
  } as CSSProperties,
  triggerRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    marginTop: "0.5rem",
  } as CSSProperties,
  triggerLabelBlock: {
    minWidth: "11rem",
    display: "flex",
    flexDirection: "column",
  } as CSSProperties,
  triggerLabel: {
    fontSize: "0.875rem",
    fontWeight: 500,
  } as CSSProperties,
  triggerDescription: {
    fontSize: "0.6875rem",
    color: colors.textSecondary,
    marginTop: "0.125rem",
  } as CSSProperties,
  select: {
    flex: 1,
    padding: "0.375rem 0.5rem",
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: "0.25rem",
    fontSize: "0.875rem",
    background: colors.background,
  } as CSSProperties,
  bodyArea: {
    width: "100%",
    padding: "0.5rem",
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: "0.25rem",
    fontFamily: "monospace",
    fontSize: "0.8125rem",
    resize: "vertical",
    boxSizing: "border-box",
  } as CSSProperties,
  iconBtn: {
    width: "2rem",
    height: "2rem",
    border: `1px solid ${colors.borderStrong}`,
    background: colors.background,
    borderRadius: "0.25rem",
    cursor: "pointer",
    fontSize: "0.875rem",
  } as CSSProperties,
  deleteIconBtn: {
    color: colors.danger,
    borderColor: colors.dangerSubtle,
  } as CSSProperties,
  buttonRow: {
    display: "flex",
    gap: "0.5rem",
    marginTop: "1rem",
    alignItems: "center",
    flexWrap: "wrap",
  } as CSSProperties,
  secondaryBtn: {
    padding: "0.5rem 1rem",
    border: `1px solid ${colors.borderStrong}`,
    background: colors.background,
    borderRadius: "0.375rem",
    cursor: "pointer",
    fontSize: "0.875rem",
  } as CSSProperties,
  primaryBtn: {
    padding: "0.5rem 1.5rem",
    background: colors.primary,
    color: colors.textInverse,
    border: "none",
    borderRadius: "0.375rem",
    cursor: "pointer",
    fontSize: "0.875rem",
  } as CSSProperties,
};
