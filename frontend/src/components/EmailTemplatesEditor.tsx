import { useState } from "react";
import type { CSSProperties } from "react";
import type { EmailTemplate, EventAction } from "../types";
import { api } from "../api";

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
    body: `{name} 様

面談ありがとうございました。
合格となりましたので、ご連絡いたします。

[次のステップを記載]

よろしくお願いいたします。`,
  },
  {
    name: "不合格通知",
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
        .map((t: EmailTemplate) => ({ id: t.id, name: t.name, body: t.body }));
    }
    return [];
  } catch {
    return [];
  }
}

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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

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
      { id: genId(), name: "", body: "" },
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
        <code>{"{studentId}"}</code> / <code>{"{interviewAt}"}</code>
        <div style={styles.helpHint}>
          (送信時に応募者の値で置換されます。{"{interviewAt}"} は未設定時に
          [未設定] と表示)
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
          <span style={{ fontSize: "0.875rem", color: "#16a34a" }}>
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
    color: "#6b7280",
    fontSize: "0.875rem",
    marginTop: 0,
    marginBottom: "0.5rem",
  } as CSSProperties,
  helpBox: {
    background: "#f9fafb",
    border: "1px solid #e5e7eb",
    borderRadius: "0.375rem",
    padding: "0.5rem 0.75rem",
    fontSize: "0.8125rem",
    marginBottom: "1rem",
  } as CSSProperties,
  helpHint: {
    color: "#6b7280",
    fontSize: "0.75rem",
    marginTop: "0.25rem",
  } as CSSProperties,
  error: {
    color: "#dc2626",
    background: "#fef2f2",
    border: "1px solid #fecaca",
    borderRadius: "0.25rem",
    padding: "0.5rem 0.75rem",
    marginBottom: "0.75rem",
    fontSize: "0.875rem",
  } as CSSProperties,
  empty: {
    padding: "1.5rem",
    textAlign: "center",
    color: "#6b7280",
    border: "1px dashed #d1d5db",
    borderRadius: "0.5rem",
    marginBottom: "0.75rem",
  } as CSSProperties,
  card: {
    border: "1px solid #e5e7eb",
    borderRadius: "0.375rem",
    padding: "0.75rem",
    background: "white",
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
    border: "1px solid #d1d5db",
    borderRadius: "0.25rem",
    fontSize: "0.875rem",
  } as CSSProperties,
  bodyArea: {
    width: "100%",
    padding: "0.5rem",
    border: "1px solid #d1d5db",
    borderRadius: "0.25rem",
    fontFamily: "monospace",
    fontSize: "0.8125rem",
    resize: "vertical",
    boxSizing: "border-box",
  } as CSSProperties,
  iconBtn: {
    width: "2rem",
    height: "2rem",
    border: "1px solid #d1d5db",
    background: "white",
    borderRadius: "0.25rem",
    cursor: "pointer",
    fontSize: "0.875rem",
  } as CSSProperties,
  deleteIconBtn: {
    color: "#dc2626",
    borderColor: "#fca5a5",
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
    border: "1px solid #d1d5db",
    background: "white",
    borderRadius: "0.375rem",
    cursor: "pointer",
    fontSize: "0.875rem",
  } as CSSProperties,
  primaryBtn: {
    padding: "0.5rem 1.5rem",
    background: "#2563eb",
    color: "white",
    border: "none",
    borderRadius: "0.375rem",
    cursor: "pointer",
    fontSize: "0.875rem",
  } as CSSProperties,
};
