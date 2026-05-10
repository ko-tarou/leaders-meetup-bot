import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { useParams } from "react-router-dom";
import { WeekCalendarPicker } from "../components/WeekCalendarPicker";
import { Button } from "../components/ui/Button";
import { useToast } from "../components/ui/Toast";
import { colors } from "../styles/tokens";

// 005-interviewer-simplify / PR #139:
// 面接官向けの公開フォーム。/interviewer-form/:token で開く。
//
// 仕様:
//   - 1 action あたり 1 つの token を共有する。誰でも token があれば
//     アクセスでき、自分の名前 + 利用可能 slot を提出できる。
//   - 同じ name で再送信すると slots を上書き (BE 側で upsert)。
//   - admin token は持っていても **送らない**。`request<T>()` ヘルパは
//     x-admin-token を自動注入するため、ここでは fetch を直接叩く。
//
// API (BE):
//   GET  /api/interviewer-form/:token  -> { eventId, eventName, actionId, actionLabel? }
//   POST /api/interviewer-form/:token  body: { name, slots: string[] }

type FormMeta = {
  eventId: string;
  eventName: string;
  actionId: string;
  actionLabel?: string;
};

export function InterviewerFormPage() {
  const { token } = useParams<{ token: string }>();
  const toast = useToast();

  const [meta, setMeta] = useState<FormMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [slots, setSlots] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submittedAt, setSubmittedAt] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      setFetchError("リンクが無効です");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setFetchError(null);
    fetch(`/api/interviewer-form/${encodeURIComponent(token)}`)
      .then(async (res) => {
        if (!res.ok) {
          if (res.status === 404) {
            throw new Error(
              "リンクが無効または失効しています。担当者から最新のリンクを共有してもらってください。",
            );
          }
          throw new Error(`読み込みに失敗しました (HTTP ${res.status})`);
        }
        return (await res.json()) as FormMeta;
      })
      .then((data) => {
        if (cancelled) return;
        setMeta(data);
      })
      .catch((e) => {
        if (cancelled) return;
        setFetchError(
          e instanceof Error ? e.message : "読み込みに失敗しました",
        );
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("お名前を入力してください");
      return;
    }
    if (trimmed.length > 50) {
      toast.error("お名前は 50 文字以内で入力してください");
      return;
    }
    if (slots.length === 0) {
      toast.error("利用可能な日時を 1 つ以上選択してください");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/interviewer-form/${encodeURIComponent(token)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: trimmed, slots }),
        },
      );
      if (!res.ok) {
        let detail = "";
        try {
          detail = await res.text();
        } catch {
          // noop
        }
        throw new Error(
          `保存に失敗しました (HTTP ${res.status}) ${detail.slice(0, 120)}`.trim(),
        );
      }
      setSubmittedAt(new Date().toISOString());
      toast.success("保存しました");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存に失敗しました");
    } finally {
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

  if (fetchError || !meta) {
    return (
      <Layout>
        <div role="alert" style={errorBoxStyle}>
          {fetchError ?? "リンクが無効です"}
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div style={{ marginBottom: "1.5rem" }}>
        <div style={eyebrowStyle}>面接官フォーム</div>
        <h1 style={{ margin: "0.25rem 0 0", fontSize: "1.5rem" }}>
          {meta.eventName}
        </h1>
        <p
          style={{
            color: colors.textSecondary,
            fontSize: "0.875rem",
            marginTop: "0.5rem",
            lineHeight: 1.6,
          }}
        >
          面接官として対応可能な日時を選択し、お名前とあわせて送信してください。
          同じお名前で再度フォームを開けば、内容を上書きして編集できます。
        </p>
      </div>

      <form onSubmit={handleSubmit}>
        <Field label="お名前 *">
          <input
            type="text"
            value={name}
            onChange={(ev) => setName(ev.target.value)}
            maxLength={50}
            placeholder="山田 太郎"
            required
            style={inputStyle}
            autoComplete="name"
          />
        </Field>

        <div style={{ marginTop: "1rem" }}>
          <div style={fieldLabelStyle}>利用可能な日時 *</div>
          <p
            style={{
              color: colors.textSecondary,
              fontSize: "0.8rem",
              margin: "0 0 0.5rem",
            }}
          >
            面談を担当できる時間帯をクリック (またはドラッグ) で選択してください。
          </p>
          <WeekCalendarPicker selectedSlots={slots} onChange={setSlots} />
        </div>

        <div style={actionsStyle}>
          <span style={{ fontSize: "0.875rem", color: colors.textSecondary }}>
            {slots.length} 枠選択中
          </span>
          <Button type="submit" disabled={submitting} isLoading={submitting}>
            {submittedAt ? "上書き保存" : "保存"}
          </Button>
        </div>

        {submittedAt && (
          <div style={successBoxStyle}>
            ご入力ありがとうございました。同じ URL を使って、いつでも内容を編集できます。
          </div>
        )}
      </form>
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

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "block", marginBottom: "0.75rem" }}>
      <span style={fieldLabelStyle}>{label}</span>
      {children}
    </label>
  );
}

const eyebrowStyle: CSSProperties = {
  fontSize: "0.75rem",
  color: colors.textSecondary,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
};

const fieldLabelStyle: CSSProperties = {
  display: "block",
  fontSize: "0.875rem",
  fontWeight: 600,
  color: colors.text,
  marginBottom: "0.25rem",
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "0.5rem 0.625rem",
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: "0.375rem",
  fontSize: "0.95rem",
  fontFamily: "inherit",
  boxSizing: "border-box",
  background: colors.background,
  color: colors.text,
};

const actionsStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.75rem",
  marginTop: "1.25rem",
  paddingTop: "0.75rem",
  borderTop: `1px solid ${colors.border}`,
};

const errorBoxStyle: CSSProperties = {
  padding: "1.25rem 1.5rem",
  background: colors.dangerSubtle,
  color: colors.danger,
  borderRadius: "0.5rem",
  textAlign: "center",
  fontSize: "0.9rem",
  lineHeight: 1.6,
};

const successBoxStyle: CSSProperties = {
  marginTop: "1rem",
  padding: "0.75rem 1rem",
  background: colors.successSubtle,
  color: colors.text,
  border: `1px solid ${colors.success}`,
  borderRadius: "0.5rem",
  fontSize: "0.875rem",
  lineHeight: 1.5,
};
