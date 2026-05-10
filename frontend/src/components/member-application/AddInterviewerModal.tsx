import { useState } from "react";
import type { CSSProperties } from "react";
import { api } from "../../api";
import type { InterviewerWithMeta } from "../../types";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toast";
import { colors } from "../../styles/tokens";

// 005-interviewer / Sprint 25:
// 面接官追加モーダル。送信成功すると inviteUrl を画面に大きく表示し、
// kota がコピーしてメールで本人に送る運用。
// 「閉じる」を押すと親に onAdded(created) を渡して一覧をリフレッシュさせる。

type Props = {
  eventId: string;
  actionId: string;
  onClose: () => void;
  onAdded: (created: InterviewerWithMeta) => void;
};

export function AddInterviewerModal({
  eventId,
  actionId,
  onClose,
  onAdded,
}: Props) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<InterviewerWithMeta | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email.trim()) {
      setError("名前とメールアドレスは必須です");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.interviewers.create(eventId, actionId, {
        name: name.trim(),
        email: email.trim(),
      });
      setCreated(res);
      onAdded(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "追加に失敗しました");
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.inviteUrl);
      toast.success("招待リンクをコピーしました");
    } catch {
      toast.error("コピーに失敗しました。手動で選択してください");
    }
  };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: 0, marginBottom: "1rem" }}>
          {created ? "面接官を追加しました" : "面接官を追加"}
        </h3>

        {created ? (
          <div>
            <p style={{ fontSize: "0.875rem", color: colors.textSecondary }}>
              下の招待リンクを面接官 ({created.name} 様) にメール等でお送りください。
              本人は自分の利用可能日時をこのリンクから登録します。
            </p>
            <div style={inviteBoxStyle}>
              <div
                style={{
                  fontSize: "0.75rem",
                  color: colors.textSecondary,
                  marginBottom: "0.25rem",
                }}
              >
                招待リンク
              </div>
              <div
                style={{
                  fontFamily: "monospace",
                  fontSize: "0.875rem",
                  wordBreak: "break-all",
                  color: colors.text,
                }}
              >
                {created.inviteUrl}
              </div>
            </div>
            <div
              style={{
                display: "flex",
                gap: "0.5rem",
                justifyContent: "flex-end",
              }}
            >
              <Button variant="secondary" onClick={handleCopy}>
                リンクをコピー
              </Button>
              <Button onClick={onClose}>閉じる</Button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            {error && (
              <div role="alert" style={errorStyle}>
                {error}
              </div>
            )}
            <Field label="名前 *">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={100}
                required
                autoFocus
                style={inputStyle}
              />
            </Field>
            <Field label="メールアドレス *">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                maxLength={200}
                required
                style={inputStyle}
              />
            </Field>
            <div
              style={{
                display: "flex",
                gap: "0.5rem",
                justifyContent: "flex-end",
                marginTop: "1rem",
              }}
            >
              <Button
                type="button"
                variant="secondary"
                onClick={onClose}
                disabled={submitting}
              >
                キャンセル
              </Button>
              <Button type="submit" disabled={submitting} isLoading={submitting}>
                追加
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: "0.75rem" }}>
      <label
        style={{
          display: "block",
          marginBottom: "0.25rem",
          fontWeight: "bold",
          fontSize: "0.875rem",
        }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.4)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
  padding: "1rem",
};

const modalStyle: CSSProperties = {
  background: colors.background,
  borderRadius: "0.5rem",
  padding: "1.5rem",
  maxWidth: 480,
  width: "100%",
  boxShadow: "0 8px 24px rgba(0,0,0,0.16)",
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "0.5rem",
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: "0.375rem",
  fontSize: "0.95rem",
  fontFamily: "inherit",
  boxSizing: "border-box",
};

const errorStyle: CSSProperties = {
  padding: "0.5rem 0.75rem",
  background: colors.dangerSubtle,
  color: colors.danger,
  borderRadius: "0.375rem",
  fontSize: "0.875rem",
  marginBottom: "0.75rem",
};

const inviteBoxStyle: CSSProperties = {
  padding: "0.75rem",
  background: colors.primarySubtle,
  border: `1px solid ${colors.primary}`,
  borderRadius: "0.375rem",
  marginBottom: "1rem",
};
