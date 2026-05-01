// Sprint 20 PR1: email_inbox アクションのメイン画面。
// 受信メッセージ一覧 + 詳細モーダル + 削除。
// アドレス管理は EmailAddressManager（別タブ）で扱う。
import { useEffect, useState } from "react";
import type { IncomingEmail } from "../types";
import { api } from "../api";

export function EmailInboxView({ eventId }: { eventId: string }) {
  const [messages, setMessages] = useState<IncomingEmail[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selected, setSelected] = useState<IncomingEmail | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.emailInbox.messages
      .list(eventId)
      .then((list) => {
        if (cancelled) return;
        setMessages(Array.isArray(list) ? list : []);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "読み込みに失敗しました");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, refreshKey]);

  if (loading) return <div style={{ padding: "1rem" }}>読み込み中...</div>;
  if (error)
    return (
      <div style={{ padding: "1rem", color: "#dc2626" }}>エラー: {error}</div>
    );

  return (
    <div style={{ padding: "1rem" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          marginBottom: "1rem",
        }}
      >
        <h3 style={{ margin: 0 }}>受信メッセージ ({messages.length}件)</h3>
        <button
          onClick={() => setRefreshKey((k) => k + 1)}
          style={{
            marginLeft: "auto",
            padding: "0.4rem 0.75rem",
            border: "1px solid #d1d5db",
            background: "white",
            borderRadius: "0.25rem",
            cursor: "pointer",
            fontSize: "0.875rem",
          }}
        >
          🔄 再読込
        </button>
      </div>

      {messages.length === 0 ? (
        <div
          style={{
            padding: "2rem",
            textAlign: "center",
            color: "#6b7280",
            border: "1px dashed #d1d5db",
            borderRadius: "0.5rem",
          }}
        >
          まだ受信メッセージはありません。
          <br />
          外部メールサービスから webhook で送信してください。
        </div>
      ) : (
        <div style={{ display: "grid", gap: "0.5rem" }}>
          {messages.map((m) => (
            <div
              key={m.id}
              role="button"
              tabIndex={0}
              onClick={() => setSelected(m)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setSelected(m);
                }
              }}
              style={{
                padding: "0.75rem",
                border: "1px solid #e5e7eb",
                borderRadius: "0.375rem",
                cursor: "pointer",
                background: "white",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                }}
              >
                <strong style={{ flex: 1 }}>
                  {m.subject || "(件名なし)"}
                </strong>
                <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>
                  {formatDate(m.receivedAt)}
                </span>
              </div>
              <div
                style={{
                  fontSize: "0.75rem",
                  color: "#6b7280",
                  marginTop: "0.25rem",
                }}
              >
                From:{" "}
                {m.fromName
                  ? `${m.fromName} <${m.fromAddress}>`
                  : m.fromAddress}{" "}
                → {m.toAddress}
              </div>
            </div>
          ))}
        </div>
      )}

      {selected && (
        <EmailDetailModal
          email={selected}
          onClose={() => setSelected(null)}
          onDeleted={() => {
            setSelected(null);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}

function EmailDetailModal({
  email,
  onClose,
  onDeleted,
}: {
  email: IncomingEmail;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const handleDelete = async () => {
    if (!confirm("このメッセージを削除しますか？")) return;
    try {
      await api.emailInbox.messages.delete(email.id);
      onDeleted();
    } catch (e) {
      alert(e instanceof Error ? e.message : "削除失敗");
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: "1rem",
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "white",
          padding: "1.5rem",
          borderRadius: "0.5rem",
          width: "min(700px, 100%)",
          maxHeight: "90vh",
          overflow: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            marginBottom: "1rem",
            gap: "0.5rem",
          }}
        >
          <h3 style={{ margin: 0, flex: 1 }}>
            {email.subject || "(件名なし)"}
          </h3>
          <button
            onClick={onClose}
            style={{
              padding: "0.4rem 0.75rem",
              border: "1px solid #d1d5db",
              background: "white",
              borderRadius: "0.25rem",
              cursor: "pointer",
            }}
          >
            閉じる
          </button>
        </div>
        <div
          style={{
            fontSize: "0.875rem",
            color: "#374151",
            marginBottom: "1rem",
            padding: "0.75rem",
            background: "#f9fafb",
            borderRadius: "0.25rem",
          }}
        >
          <div>
            差出人:{" "}
            {email.fromName
              ? `${email.fromName} <${email.fromAddress}>`
              : email.fromAddress}
          </div>
          <div>宛先: {email.toAddress}</div>
          <div>受信: {formatDate(email.receivedAt)}</div>
        </div>
        <div
          style={{
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            padding: "0.75rem",
            background: "#f9fafb",
            borderRadius: "0.25rem",
            fontSize: "0.875rem",
            lineHeight: 1.6,
          }}
        >
          {email.body || "(本文なし)"}
        </div>
        <div style={{ marginTop: "1rem", textAlign: "right" }}>
          <button
            onClick={handleDelete}
            style={{
              background: "#dc2626",
              color: "white",
              border: "none",
              padding: "0.5rem 1rem",
              borderRadius: "0.25rem",
              cursor: "pointer",
            }}
          >
            削除
          </button>
        </div>
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // JST 表示 (UTC + 9h)
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const yyyy = jst.getUTCFullYear();
  const mm = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(jst.getUTCDate()).padStart(2, "0");
  const hh = String(jst.getUTCHours()).padStart(2, "0");
  const mi = String(jst.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}/${mm}/${dd} ${hh}:${mi}`;
}
