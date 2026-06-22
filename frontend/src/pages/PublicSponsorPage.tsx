import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { useIsMobile } from "../hooks/useIsMobile";
import { colors } from "../styles/tokens";

// sponsor_application 公開フォーム (個人スポンサー前提・0065 / 0069)。
// 項目: お名前(氏名・必須) / 所属(任意) / メール(必須) /
// 当日来られますか?(任意) / 応援メッセージ・コメント(任意)。
// 協賛金額は一律 5000 円固定 (0069) で、入力欄は廃止し固定表示する。
// 企業前提の会社名/担当者/期間/用途は廃止。
// 認証不要。event 情報は公開エンドポイント /api/sponsor/:eventId/event で取得する。

const FLAT_AMOUNT = 5000;
type AttendanceOnDay = "coming" | "not_coming" | "undecided";
const ATTENDANCE_OPTIONS: { value: AttendanceOnDay; label: string }[] = [
  { value: "coming", label: "来る" },
  { value: "not_coming", label: "来ない" },
  { value: "undecided", label: "未定" },
];

type PublicSponsorEvent = {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
};

export function PublicSponsorPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [event, setEvent] = useState<PublicSponsorEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [affiliation, setAffiliation] = useState("");
  const [email, setEmail] = useState("");
  const [attendanceOnDay, setAttendanceOnDay] = useState<AttendanceOnDay | "">("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!eventId) {
      setLoading(false);
      return;
    }
    api.sponsor
      .getEvent(eventId)
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
    if (!name.trim()) {
      setError("お名前を入力してください");
      return;
    }
    if (!email.trim()) {
      setError("メールアドレスを入力してください");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await api.sponsor.apply(eventId!, {
        name: name.trim(),
        affiliation: affiliation.trim() || undefined,
        email: email.trim(),
        attendanceOnDay: attendanceOnDay || undefined,
        message: message.trim() || undefined,
      });
      navigate(`/sponsor/${eventId}/thanks`);
    } catch (err) {
      // BE は重複連投を 429 (too_many_requests) で返す。
      const msg = err instanceof Error ? err.message : "送信に失敗しました";
      setError(
        msg.includes("429") || msg.includes("too_many_requests")
          ? "短時間に複数回送信されました。しばらくしてから再度お試しください。"
          : "送信に失敗しました。入力内容をご確認ください。",
      );
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <Layout>
        <div style={{ color: colors.textSecondary }}>読み込み中...</div>
      </Layout>
    );
  }
  if (!event) {
    return (
      <Layout>
        <div
          style={{ padding: "2rem", textAlign: "center", color: colors.danger }}
        >
          イベントが見つかりません
        </div>
      </Layout>
    );
  }
  if (!event.enabled) {
    return (
      <Layout>
        <h1
          style={{
            margin: "0 0 0.5rem",
            fontSize: isMobile ? "1.25rem" : "1.5rem",
          }}
        >
          {event.name} スポンサー募集
        </h1>
        <NoticeBox>現在スポンサーの募集は受付停止中です。</NoticeBox>
      </Layout>
    );
  }

  return (
    <Layout>
      <h1 style={{ margin: "0 0 0.5rem", fontSize: "1.5rem" }}>
        {event.name} スポンサー募集
      </h1>
      <p style={{ color: colors.textSecondary, marginBottom: "1.5rem" }}>
        個人スポンサーを募集しています。応援してくださる方は以下のフォームにご記入ください。送信後、ご記入のメールアドレス宛に確認メールをお送りします。メール内のリンクをクリックして申込を確定してください。
      </p>

      {error && (
        <div
          role="alert"
          style={{
            padding: "0.75rem",
            background: colors.dangerSubtle,
            color: colors.danger,
            borderRadius: "0.375rem",
            marginBottom: "1rem",
            fontSize: "0.9rem",
          }}
        >
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <Field label="お名前（氏名） *">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={100}
            style={inputStyle}
          />
        </Field>
        <Field
          label="所属（任意）"
          hint="学校・会社・団体など（任意）"
        >
          <input
            type="text"
            value={affiliation}
            onChange={(e) => setAffiliation(e.target.value)}
            maxLength={200}
            style={inputStyle}
          />
        </Field>
        <Field label="メールアドレス *" hint="確認メール・連絡用にご記入ください">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            maxLength={200}
            style={inputStyle}
          />
        </Field>
        <Field label="ご協賛金額" hint="個人スポンサーは一律の金額です">
          <div
            style={{
              ...inputStyle,
              display: "flex",
              alignItems: "center",
              background: colors.surface,
              fontWeight: "bold",
            }}
          >
            {FLAT_AMOUNT.toLocaleString()} 円
          </div>
        </Field>
        <Field label="当日来られますか？（任意）">
          <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
            {ATTENDANCE_OPTIONS.map((o) => (
              <label
                key={o.value}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.375rem",
                  cursor: "pointer",
                  fontSize: "0.95rem",
                }}
              >
                <input
                  type="radio"
                  name="attendanceOnDay"
                  value={o.value}
                  checked={attendanceOnDay === o.value}
                  onChange={() => setAttendanceOnDay(o.value)}
                />
                {o.label}
              </label>
            ))}
            {attendanceOnDay && (
              <button
                type="button"
                onClick={() => setAttendanceOnDay("")}
                style={{
                  border: "none",
                  background: "none",
                  color: colors.textSecondary,
                  cursor: "pointer",
                  fontSize: "0.85rem",
                  textDecoration: "underline",
                }}
              >
                選択を解除
              </button>
            )}
          </div>
        </Field>
        <Field
          label="応援メッセージ・コメント（任意）"
          hint="運営への応援メッセージがあればご記入ください"
        >
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={1000}
            rows={4}
            style={{ ...inputStyle, resize: "vertical" }}
          />
        </Field>

        <button
          type="submit"
          disabled={submitting}
          style={{
            background: submitting ? colors.primarySubtle : colors.primary,
            color: colors.textInverse,
            padding: isMobile ? "0.875rem 1rem" : "0.75rem 2rem",
            width: isMobile ? "100%" : undefined,
            border: "none",
            borderRadius: "0.375rem",
            fontSize: "1rem",
            cursor: submitting ? "not-allowed" : "pointer",
            fontWeight: "bold",
            minHeight: 44,
          }}
        >
          {submitting ? "送信中..." : "申込を送信"}
        </button>
      </form>
    </Layout>
  );
}

export function PublicSponsorThanksPage() {
  return (
    <Layout>
      <div style={{ textAlign: "center", padding: "3rem 1rem" }}>
        <h1 style={{ marginTop: 0, fontSize: "1.5rem" }}>
          申込ありがとうございました
        </h1>
        <p style={{ color: colors.textSecondary }}>
          ご記入のメールアドレス宛に確認メールをお送りしました。メール内のリンクをクリックして申込を確定してください。
        </p>
      </div>
    </Layout>
  );
}

function Layout({ children }: { children: React.ReactNode }) {
  const isMobile = useIsMobile();
  return (
    <div
      style={{
        maxWidth: 720,
        margin: "0 auto",
        padding: isMobile ? "1.25rem 0.875rem" : "2rem 1rem",
        fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
        color: colors.text,
      }}
    >
      {children}
    </div>
  );
}

function NoticeBox({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="status"
      style={{
        padding: "1.5rem 1rem",
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderRadius: "0.5rem",
        color: colors.text,
        fontSize: "0.95rem",
        textAlign: "center",
        lineHeight: 1.6,
      }}
    >
      {children}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
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
      {hint && (
        <p
          style={{
            fontSize: "0.8rem",
            color: colors.textSecondary,
            margin: "0 0 0.375rem",
          }}
        >
          {hint}
        </p>
      )}
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.5rem",
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: "0.375rem",
  fontSize: "1rem",
  fontFamily: "inherit",
  boxSizing: "border-box",
};
