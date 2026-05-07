import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { WeekCalendarPicker } from "../components/WeekCalendarPicker";
import {
  HOW_FOUND_LABEL,
  INTERVIEW_LOCATION_LABEL,
  type HowFound,
  type InterviewLocation,
} from "../types";
import { colors } from "../styles/tokens";

// 005-hotfix: 公開エンドポイント /api/apply/:eventId/event が返す
// 最小フィールドのみを表現する型。フォーム上部の表示に必要な情報のみ。
type PublicEvent = {
  id: string;
  name: string;
  type: string;
};

// Sprint 19 PR1: 公開エンドポイントから取得する availability の型
type Availability = {
  enabled: boolean;
  leaderAvailableSlots: string[];
  eventName?: string;
};

export function PublicApplyPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const navigate = useNavigate();
  const [event, setEvent] = useState<PublicEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  // Sprint 19 PR2: Google Form 準拠の新フィールド
  const [studentId, setStudentId] = useState("");
  const [howFound, setHowFound] = useState<HowFound | "">("");
  const [interviewLocation, setInterviewLocation] = useState<
    InterviewLocation | ""
  >("");
  const [existingActivities, setExistingActivities] = useState("");
  const [slots, setSlots] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 005-hotfix: 公開エンドポイント経由で event を取得する。
  // 旧実装は api.events.get() を呼んでおり、これは admin auth (x-admin-token)
  // が必須の /api/orgs/:eventId を叩くため応募者は 401 になる。
  // 既存の availability fetch と同じく fetch を直接使い、token を注入しない。
  useEffect(() => {
    if (!eventId) {
      setLoading(false);
      return;
    }
    fetch(`/api/apply/${eventId}/event`)
      .then(async (res) => {
        if (!res.ok) throw new Error("event fetch failed");
        return (await res.json()) as PublicEvent;
      })
      .then((e) => {
        setEvent(e);
        setLoading(false);
      })
      .catch(() => {
        setEvent(null);
        setLoading(false);
      });
  }, [eventId]);

  // Sprint 19 PR1: availability をフェッチ
  useEffect(() => {
    if (!eventId) return;
    fetch(`/api/apply/${eventId}/availability`)
      .then(async (res) => {
        if (!res.ok) throw new Error("availability fetch failed");
        return (await res.json()) as Availability;
      })
      .then((data) => setAvailability(data))
      .catch(() =>
        setAvailability({ enabled: false, leaderAvailableSlots: [] }),
      );
  }, [eventId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email.trim()) {
      setError("お名前とメールアドレスは必須です");
      return;
    }
    if (!studentId.trim()) {
      setError("学籍番号を入力してください");
      return;
    }
    if (!howFound) {
      setError("どこで知ったかを選択してください");
      return;
    }
    if (!interviewLocation) {
      setError("面談場所を選択してください");
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
        studentId: studentId.trim(),
        howFound,
        interviewLocation,
        existingActivities: existingActivities.trim() || undefined,
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

  if (loading || availability === null) {
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
          style={{
            padding: "2rem",
            textAlign: "center",
            color: colors.danger,
          }}
        >
          イベントが見つかりません
        </div>
      </Layout>
    );
  }

  // Sprint 19 PR1: 受付停止 / 候補未設定 の文言分岐
  if (!availability.enabled) {
    return (
      <Layout>
        <h1 style={{ margin: "0 0 0.5rem", fontSize: "1.5rem" }}>
          {event.name} 応募フォーム
        </h1>
        <NoticeBox>現在この応募は受付停止中です。</NoticeBox>
      </Layout>
    );
  }
  if (availability.leaderAvailableSlots.length === 0) {
    return (
      <Layout>
        <h1 style={{ margin: "0 0 0.5rem", fontSize: "1.5rem" }}>
          {event.name} 応募フォーム
        </h1>
        <NoticeBox>
          面談可能な日時候補がまだ設定されていません。しばらくしてから再度ご確認ください。
        </NoticeBox>
      </Layout>
    );
  }

  return (
    <Layout>
      <h1 style={{ margin: "0 0 0.5rem", fontSize: "1.5rem" }}>
        {event.name} 応募フォーム
      </h1>
      <p style={{ color: colors.textSecondary, marginBottom: "1.5rem" }}>
        参加希望の方は以下のフォームにご記入ください。後ほどメールでご連絡いたします。
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
        <Field label="お名前 *">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={100}
            placeholder="例: 山田 太郎"
            style={inputStyle}
          />
        </Field>
        <Field label="メールアドレス *" hint="運営からの連絡用にご記入ください">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            maxLength={200}
            style={inputStyle}
          />
        </Field>
        <Field label="学籍番号 *" hint="例: 1 EP 1 - 1">
          <input
            type="text"
            value={studentId}
            onChange={(e) => setStudentId(e.target.value)}
            required
            maxLength={50}
            placeholder="1 EP 1 - 1"
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
            DevelopersHubをどこで知りましたか？ *
          </label>
          <div style={{ display: "grid", gap: "0.5rem" }}>
            {(Object.keys(HOW_FOUND_LABEL) as HowFound[]).map((key) => (
              <label
                key={key}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  cursor: "pointer",
                  fontSize: "0.95rem",
                }}
              >
                <input
                  type="radio"
                  name="howFound"
                  value={key}
                  checked={howFound === key}
                  onChange={() => setHowFound(key)}
                />
                <span>{HOW_FOUND_LABEL[key]}</span>
              </label>
            ))}
          </div>
        </div>

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
              color: colors.textSecondary,
              margin: "0 0 0.5rem",
            }}
          >
            ご都合の良い時間帯をクリック（またはドラッグ）で選択してください。リーダー側の都合により、選択できるのは候補として表示されている時間帯のみです。
          </p>
          <WeekCalendarPicker
            selectedSlots={slots}
            onChange={setSlots}
            restrictTo={availability.leaderAvailableSlots}
          />
        </div>

        <div style={{ marginBottom: "1.5rem" }}>
          <label
            style={{
              display: "block",
              marginBottom: "0.5rem",
              fontWeight: "bold",
              fontSize: "0.875rem",
            }}
          >
            面談場所の希望 *
          </label>
          <div style={{ display: "grid", gap: "0.5rem" }}>
            {(Object.keys(INTERVIEW_LOCATION_LABEL) as InterviewLocation[]).map(
              (key) => (
                <label
                  key={key}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.5rem",
                    cursor: "pointer",
                    fontSize: "0.95rem",
                  }}
                >
                  <input
                    type="radio"
                    name="interviewLocation"
                    value={key}
                    checked={interviewLocation === key}
                    onChange={() => setInterviewLocation(key)}
                  />
                  <span>{INTERVIEW_LOCATION_LABEL[key]}</span>
                </label>
              ),
            )}
          </div>
        </div>

        <Field
          label="現在参加している活動（任意）"
          hint="他のサークル・プロジェクト等、差し支えなければご記入ください"
        >
          <input
            type="text"
            value={existingActivities}
            onChange={(e) => setExistingActivities(e.target.value)}
            maxLength={500}
            style={inputStyle}
          />
        </Field>

        <button
          type="submit"
          disabled={submitting}
          style={{
            background: submitting ? colors.primarySubtle : colors.primary,
            color: colors.textInverse,
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
        <p style={{ color: colors.textSecondary }}>
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
        color: colors.text,
      }}
    >
      {children}
    </div>
  );
}

// Sprint 19 PR1: 受付停止 / 候補未設定 のお知らせ枠
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
