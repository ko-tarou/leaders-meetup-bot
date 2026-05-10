import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { InterviewerSlotsEditor } from "../components/member-application/InterviewerSlotsEditor";
import { colors } from "../styles/tokens";

// 005-interviewer / Sprint 25:
// 面接官専用の公開ページ。/interviewer/:token でアクセスする。
// admin token を持たず、token そのものが認可情報。
//
// API:
//   GET  /api/interviewer/:token         → interviewer info + slots を取得
//   PUT  /api/interviewer/:token/slots   → slots を上書き保存
//
// `request<T>` は admin token を header に注入してしまうので使わず、
// fetch を直接叩く（管理者がたまたま admin token を持っていてもサーバ側に送らない）。

type InterviewerInfo = {
  id: string;
  name: string;
  email: string;
  eventActionId: string;
};

type EventInfo = {
  id: string;
  name: string;
};

type GetResponse = {
  interviewer: InterviewerInfo;
  event: EventInfo | null;
  slots: string[];
};

export function InterviewerPage() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<GetResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      setFetchError("invalid_token");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setFetchError(null);
    fetch(`/api/interviewer/${encodeURIComponent(token)}`)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(
            res.status === 404
              ? "リンクが無効です。担当者にご確認ください。"
              : `読み込みに失敗しました (HTTP ${res.status})`,
          );
        }
        return (await res.json()) as GetResponse;
      })
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setFetchError(e instanceof Error ? e.message : "読み込みに失敗しました");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleSave = async (slots: string[]) => {
    if (!token) throw new Error("invalid_token");
    const res = await fetch(
      `/api/interviewer/${encodeURIComponent(token)}/slots`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slots }),
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
  };

  if (loading) {
    return (
      <Layout>
        <div style={{ color: colors.textSecondary }}>読み込み中...</div>
      </Layout>
    );
  }

  if (fetchError || !data) {
    return (
      <Layout>
        <div
          role="alert"
          style={{
            padding: "1.5rem",
            background: colors.dangerSubtle,
            color: colors.danger,
            borderRadius: "0.5rem",
            textAlign: "center",
          }}
        >
          {fetchError ?? "リンクが無効です"}
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div style={{ marginBottom: "1rem" }}>
        <div
          style={{
            fontSize: "0.75rem",
            color: colors.textSecondary,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
          }}
        >
          面接官専用ページ
        </div>
        <h1 style={{ margin: "0.25rem 0 0", fontSize: "1.4rem" }}>
          {data.interviewer.name} さん
        </h1>
        {data.event && (
          <div
            style={{
              color: colors.textSecondary,
              fontSize: "0.875rem",
              marginTop: "0.25rem",
            }}
          >
            {data.event.name} の面談担当
          </div>
        )}
      </div>

      <InterviewerSlotsEditor
        title="利用可能な日時を設定してください"
        description="面談を担当できる時間帯をクリック（またはドラッグ）で選択してください。応募者の候補にはここで選択された時間帯が表示されます。"
        initialSlots={data.slots}
        onSave={handleSave}
      />
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
