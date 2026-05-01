import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { WeekCalendarPicker } from "../components/WeekCalendarPicker";
import type { Event } from "../types";

export function PublicApplyPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const navigate = useNavigate();
  const [event, setEvent] = useState<Event | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [motivation, setMotivation] = useState("");
  const [introduction, setIntroduction] = useState("");
  const [slots, setSlots] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!eventId) {
      setLoading(false);
      return;
    }
    api.events
      .get(eventId)
      .then((e) => {
        setEvent(e);
        setLoading(false);
      })
      .catch(() => {
        setEvent(null);
        setLoading(false);
      });
  }, [eventId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email.trim()) {
      setError("お名前とメールアドレスは必須です");
      return;
    }
    if (slots.length === 0) {
      setError("面談希望日時を1つ以上選択してください");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.applications.apply(eventId!, {
        name: name.trim(),
        email: email.trim(),
        motivation: motivation.trim() || undefined,
        introduction: introduction.trim() || undefined,
        availableSlots: slots,
      });
      if (!res.ok) {
        throw new Error(res.error ?? "送信に失敗しました");
      }
      navigate(`/apply/${eventId}/thanks`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "送信に失敗しました");
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <Layout>
        <div style={{ color: "#6b7280" }}>読み込み中...</div>
      </Layout>
    );
  }
  if (!event) {
    return (
      <Layout>
        <div
          style={{
            padding: "2rem",
            textAlign: "center",
            color: "#dc2626",
          }}
        >
          イベントが見つかりません
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <h1 style={{ margin: "0 0 0.5rem", fontSize: "1.5rem" }}>
        {event.name} 応募フォーム
      </h1>
      <p style={{ color: "#6b7280", marginBottom: "1.5rem" }}>
        参加希望の方は以下のフォームにご記入ください。後ほどメールでご連絡いたします。
      </p>

      {error && (
        <div
          role="alert"
          style={{
            padding: "0.75rem",
            background: "#fee2e2",
            color: "#dc2626",
            borderRadius: "0.375rem",
            marginBottom: "1rem",
            fontSize: "0.9rem",
          }}
        >
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <Field label="お名前 *">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={100}
            style={inputStyle}
          />
        </Field>
        <Field label="メールアドレス *">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            maxLength={200}
            style={inputStyle}
          />
        </Field>
        <Field label="志望動機">
          <textarea
            value={motivation}
            onChange={(e) => setMotivation(e.target.value)}
            rows={4}
            maxLength={2000}
            style={inputStyle}
          />
        </Field>
        <Field label="自己紹介">
          <textarea
            value={introduction}
            onChange={(e) => setIntroduction(e.target.value)}
            rows={4}
            maxLength={2000}
            style={inputStyle}
          />
        </Field>

        <div style={{ marginBottom: "1.5rem" }}>
          <label
            style={{
              display: "block",
              marginBottom: "0.5rem",
              fontWeight: "bold",
              fontSize: "0.875rem",
            }}
          >
            面談希望日時 *
          </label>
          <p
            style={{
              fontSize: "0.875rem",
              color: "#6b7280",
              margin: "0 0 0.5rem",
            }}
          >
            ご都合の良い時間帯をクリック（またはドラッグ）で選択してください。複数選択可能です。
          </p>
          <WeekCalendarPicker selectedSlots={slots} onChange={setSlots} />
        </div>

        <button
          type="submit"
          disabled={submitting}
          style={{
            background: submitting ? "#93c5fd" : "#2563eb",
            color: "white",
            padding: "0.75rem 2rem",
            border: "none",
            borderRadius: "0.375rem",
            fontSize: "1rem",
            cursor: submitting ? "not-allowed" : "pointer",
            fontWeight: "bold",
          }}
        >
          {submitting ? "送信中..." : "応募を送信"}
        </button>
      </form>
    </Layout>
  );
}

export function PublicThanksPage() {
  return (
    <Layout>
      <div style={{ textAlign: "center", padding: "3rem 1rem" }}>
        <h1 style={{ marginTop: 0, fontSize: "1.5rem" }}>
          応募ありがとうございました
        </h1>
        <p style={{ color: "#6b7280" }}>
          内容を確認のうえ、後ほどメールでご連絡いたします。
        </p>
      </div>
    </Layout>
  );
}

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        maxWidth: 720,
        margin: "0 auto",
        padding: "2rem 1rem",
        fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
        color: "#111827",
      }}
    >
      {children}
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
    <div style={{ marginBottom: "1rem" }}>
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

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.5rem",
  border: "1px solid #d1d5db",
  borderRadius: "0.375rem",
  fontSize: "1rem",
  fontFamily: "inherit",
  boxSizing: "border-box",
};
