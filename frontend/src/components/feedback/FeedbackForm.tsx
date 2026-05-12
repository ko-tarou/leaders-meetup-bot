/**
 * 005-feedback: フィードバック送信フォーム (改善要望 / バグ報告 / 使い方の質問)。
 *
 * - admin / 公開モード両方から呼ばれる (admin token 無しでも叩ける public API)。
 * - 送信成功時は完了メッセージを出してフォームを reset する。
 * - サーバー側で fail-soft なので 200 が返れば成功扱い。
 */
import { useState } from "react";
import { api } from "../../api";
import { getPublicMode } from "../../hooks/usePublicMode";
import { colors } from "../../styles/tokens";
import type { FeedbackCategory } from "../../types";

const CATEGORIES: { value: FeedbackCategory; label: string }[] = [
  { value: "improvement", label: "💡 改善要望" },
  { value: "bug", label: "🐛 バグ報告" },
  { value: "question", label: "❓ 使い方の質問" },
];

export function FeedbackForm() {
  const [category, setCategory] = useState<FeedbackCategory>("improvement");
  const [message, setMessage] = useState("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!message.trim()) {
      setError("メッセージを入力してください");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await api.feedback.submit({
        category,
        message: message.trim(),
        name: name.trim() || undefined,
        pageUrl: window.location.href,
        publicMode: getPublicMode(),
      });
      setDone(true);
      setMessage("");
      setName("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "送信に失敗しました");
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div style={styles.doneBox}>
        <div style={{ fontSize: 32, marginBottom: 8 }}>🙏</div>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>
          送信しました。ありがとうございます！
        </div>
        <div style={{ fontSize: 13, color: colors.textSecondary }}>
          いただいた内容を確認します。
        </div>
        <button
          type="button"
          onClick={() => setDone(false)}
          style={styles.linkBtn}
        >
          もう一度送る
        </button>
      </div>
    );
  }

  return (
    <div style={styles.form}>
      <div style={styles.field}>
        <label style={styles.label}>種別</label>
        <div style={styles.categoryRow}>
          {CATEGORIES.map((c) => {
            const active = category === c.value;
            return (
              <button
                key={c.value}
                type="button"
                onClick={() => setCategory(c.value)}
                style={{
                  ...styles.categoryChip,
                  background: active ? colors.primary : colors.background,
                  color: active ? colors.textInverse : colors.text,
                  borderColor: active ? colors.primary : colors.borderStrong,
                }}
              >
                {c.label}
              </button>
            );
          })}
        </div>
      </div>

      <div style={styles.field}>
        <label style={styles.label}>名前 (任意)</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="匿名でも OK"
          disabled={submitting}
          style={styles.input}
        />
      </div>

      <div style={styles.field}>
        <label style={styles.label}>
          メッセージ <span style={{ color: colors.danger }}>*</span>
        </label>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="気になる点や改善案、再現手順などを自由に書いてください..."
          disabled={submitting}
          rows={6}
          style={styles.textarea}
        />
      </div>

      {error && <div style={styles.error}>{error}</div>}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={submitting || !message.trim()}
        style={{
          ...styles.submit,
          opacity: submitting || !message.trim() ? 0.5 : 1,
          cursor: submitting || !message.trim() ? "not-allowed" : "pointer",
        }}
      >
        {submitting ? "送信中..." : "送信"}
      </button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  form: { display: "flex", flexDirection: "column", gap: 12 },
  field: { display: "flex", flexDirection: "column", gap: 4 },
  label: { fontSize: 12, fontWeight: 600, color: colors.textSecondary },
  categoryRow: { display: "flex", gap: 6, flexWrap: "wrap" },
  categoryChip: {
    padding: "6px 10px",
    fontSize: 13,
    border: "1px solid",
    borderRadius: 16,
    cursor: "pointer",
  },
  input: {
    padding: "8px 10px",
    fontSize: 14,
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: 4,
  },
  textarea: {
    padding: "8px 10px",
    fontSize: 14,
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: 4,
    fontFamily: "inherit",
    resize: "vertical",
  },
  submit: {
    padding: "10px 20px",
    fontSize: 14,
    fontWeight: 600,
    background: colors.primary,
    color: colors.textInverse,
    border: "none",
    borderRadius: 6,
    marginTop: 4,
  },
  error: {
    padding: "8px 10px",
    background: colors.dangerSubtle,
    color: colors.danger,
    fontSize: 13,
    borderRadius: 4,
  },
  doneBox: {
    padding: "24px 16px",
    textAlign: "center",
  },
  linkBtn: {
    marginTop: 16,
    background: "transparent",
    border: "none",
    color: colors.primary,
    cursor: "pointer",
    fontSize: 13,
    textDecoration: "underline",
  },
};
