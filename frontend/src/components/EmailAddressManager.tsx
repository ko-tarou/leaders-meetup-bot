// Sprint 20 PR1: email_inbox アクションのアドレス管理サブタブ。
// 監視メアド一覧の追加 / 削除を扱う。実体は event_actions.config.addresses (JSON)。
import { useEffect, useState } from "react";
import type { EmailAddress } from "../types";
import { api } from "../api";

export function EmailAddressManager({ eventId }: { eventId: string }) {
  const [addresses, setAddresses] = useState<EmailAddress[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.emailInbox.addresses
      .list(eventId)
      .then((list) => {
        if (cancelled) return;
        setAddresses(Array.isArray(list) ? list : []);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  const save = async (next: EmailAddress[]) => {
    setSaving(true);
    setError(null);
    try {
      const res = await api.emailInbox.addresses.update(eventId, next);
      // backend が正規化済みリストを返すのでそれを採用
      setAddresses(res.addresses ?? next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  const handleAdd = () => {
    setError(null);
    const email = newEmail.trim();
    if (!email) {
      setError("メールアドレスを入力してください");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("メールアドレスの形式が不正です");
      return;
    }
    if (addresses.some((a) => a.email.toLowerCase() === email.toLowerCase())) {
      setError("既に登録されています");
      return;
    }
    const name = newName.trim();
    save([...addresses, { email, ...(name ? { name } : {}) }]);
    setNewEmail("");
    setNewName("");
  };

  const handleRemove = (i: number) => {
    if (!confirm(`${addresses[i].email} を削除しますか？`)) return;
    save(addresses.filter((_, idx) => idx !== i));
  };

  if (loading) return <div style={{ padding: "1rem" }}>読み込み中...</div>;

  const webhookUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/email-inbox/incoming`
      : "/api/email-inbox/incoming";

  return (
    <div style={{ padding: "1rem" }}>
      <h3 style={{ marginTop: 0 }}>
        監視するメールアドレス ({addresses.length}件)
      </h3>
      <p
        style={{
          color: "#6b7280",
          fontSize: "0.875rem",
          marginBottom: "1rem",
        }}
      >
        ここに登録されたアドレス宛のメールを webhook 経由で受信します。
      </p>

      {error && (
        <div style={{ color: "#dc2626", marginBottom: "0.5rem" }}>{error}</div>
      )}

      <div
        style={{ display: "grid", gap: "0.5rem", marginBottom: "1.5rem" }}
      >
        {addresses.length === 0 ? (
          <div
            style={{
              padding: "1rem",
              textAlign: "center",
              color: "#6b7280",
              border: "1px dashed #d1d5db",
              borderRadius: "0.375rem",
            }}
          >
            アドレスが登録されていません。下の「新規追加」から追加してください。
          </div>
        ) : (
          addresses.map((a, i) => (
            <div
              key={`${a.email}-${i}`}
              style={{
                padding: "0.75rem",
                border: "1px solid #e5e7eb",
                borderRadius: "0.375rem",
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                background: "white",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                {a.name && (
                  <strong style={{ marginRight: "0.5rem" }}>{a.name}</strong>
                )}
                <span style={{ color: "#374151", wordBreak: "break-all" }}>
                  {a.email}
                </span>
              </div>
              <button
                onClick={() => handleRemove(i)}
                disabled={saving}
                style={{
                  color: "#dc2626",
                  border: "1px solid #dc2626",
                  background: "white",
                  padding: "0.25rem 0.5rem",
                  borderRadius: "0.25rem",
                  cursor: saving ? "wait" : "pointer",
                }}
              >
                削除
              </button>
            </div>
          ))
        )}
      </div>

      <div style={{ borderTop: "1px solid #e5e7eb", paddingTop: "1rem" }}>
        <h4 style={{ marginTop: 0 }}>新規追加</h4>
        <div
          style={{ display: "grid", gap: "0.5rem", maxWidth: "500px" }}
        >
          <input
            type="email"
            placeholder="email@example.com"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            disabled={saving}
            style={{
              padding: "0.5rem",
              border: "1px solid #d1d5db",
              borderRadius: "0.25rem",
            }}
          />
          <input
            type="text"
            placeholder="ラベル（任意、例: 代表アドレス）"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            disabled={saving}
            style={{
              padding: "0.5rem",
              border: "1px solid #d1d5db",
              borderRadius: "0.25rem",
            }}
          />
          <button
            onClick={handleAdd}
            disabled={saving}
            style={{
              background: "#2563eb",
              color: "white",
              border: "none",
              padding: "0.5rem 1rem",
              borderRadius: "0.25rem",
              cursor: saving ? "wait" : "pointer",
            }}
          >
            + 追加
          </button>
        </div>
      </div>

      <div
        style={{
          marginTop: "1.5rem",
          padding: "0.75rem",
          background: "#f0f9ff",
          borderRadius: "0.375rem",
          fontSize: "0.875rem",
        }}
      >
        <strong>📡 Webhook URL:</strong>
        <code
          style={{
            display: "block",
            padding: "0.25rem 0.5rem",
            background: "white",
            borderRadius: "0.25rem",
            marginTop: "0.25rem",
            wordBreak: "break-all",
          }}
        >
          POST {webhookUrl}
        </code>
        <div style={{ marginTop: "0.5rem", color: "#1e40af" }}>
          ヘッダー: <code>X-Webhook-Token: $EMAIL_WEBHOOK_TOKEN</code>
          <br />
          body:{" "}
          <code>{`{ "to": "...", "from": "...", "subject": "...", "body": "..." }`}</code>
        </div>
      </div>
    </div>
  );
}
