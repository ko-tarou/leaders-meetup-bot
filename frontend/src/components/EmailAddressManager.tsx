// Sprint 20 PR1: email_inbox アクションのアドレス管理サブタブ。
// 監視メアド一覧の追加 / 削除を扱う。実体は event_actions.config.addresses (JSON)。
// Sprint 21 PR1: 各アドレスに対して「Gmail 連携」ボタンを追加。連携済なら最終ポーリング時刻を表示。
import { useEffect, useState } from "react";
import type { EmailAddress, GmailIntegration } from "../types";
import { api } from "../api";

type Props = {
  eventId: string;
  // Sprint 21 PR1: Gmail 連携は event_action 単位なので action.id が必要。
  // 連携機能を使わない呼び出し元との後方互換のため optional にしておく。
  actionId?: string;
};

export function EmailAddressManager({ eventId, actionId }: Props) {
  const [addresses, setAddresses] = useState<EmailAddress[]>([]);
  const [integrations, setIntegrations] = useState<GmailIntegration[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const tasks: Promise<unknown>[] = [
      api.emailInbox.addresses.list(eventId).then((list) => {
        if (!cancelled) {
          setAddresses(Array.isArray(list) ? list : []);
        }
      }),
    ];
    if (actionId) {
      tasks.push(
        api.gmail
          .list(actionId)
          .then((list) => {
            if (!cancelled) {
              setIntegrations(Array.isArray(list) ? list : []);
            }
          })
          .catch(() => {
            // 連携情報の取得失敗は致命的ではないので握り潰す（UI は未連携扱い）
            if (!cancelled) setIntegrations([]);
          }),
      );
    } else {
      setIntegrations([]);
    }
    Promise.all(tasks)
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, actionId, refreshKey]);

  const findIntegration = (email: string): GmailIntegration | undefined =>
    integrations.find((g) => g.email.toLowerCase() === email.toLowerCase());

  const handleConnect = (email: string) => {
    if (!actionId) return;
    window.location.href = api.gmail.installUrl(actionId, email);
  };

  const handleDisconnect = async (id: string, email: string) => {
    if (!confirm(`${email} の Gmail 連携を解除しますか？`)) return;
    try {
      await api.gmail.disconnect(id);
      setRefreshKey((k) => k + 1);
    } catch (e) {
      alert(e instanceof Error ? e.message : "連携解除に失敗しました");
    }
  };

  const formatPolledAt = (iso: string | null): string => {
    if (!iso) return "未ポーリング";
    try {
      return new Date(iso).toLocaleString("ja-JP");
    } catch {
      return iso;
    }
  };

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
          addresses.map((a, i) => {
            const ig = findIntegration(a.email);
            return (
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
                  flexWrap: "wrap",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  {a.name && (
                    <strong style={{ marginRight: "0.5rem" }}>{a.name}</strong>
                  )}
                  <span style={{ color: "#374151", wordBreak: "break-all" }}>
                    {a.email}
                  </span>
                  {ig && (
                    <div
                      style={{
                        fontSize: "0.75rem",
                        color: "#059669",
                        marginTop: "0.25rem",
                      }}
                    >
                      ✓ Gmail 連携済 / 最終ポーリング:{" "}
                      {formatPolledAt(ig.lastPolledAt)}
                    </div>
                  )}
                </div>
                {actionId && (
                  ig ? (
                    <button
                      onClick={() => handleDisconnect(ig.id, a.email)}
                      style={{
                        color: "#6b7280",
                        border: "1px solid #d1d5db",
                        background: "white",
                        padding: "0.25rem 0.5rem",
                        borderRadius: "0.25rem",
                        cursor: "pointer",
                      }}
                    >
                      連携解除
                    </button>
                  ) : (
                    <button
                      onClick={() => handleConnect(a.email)}
                      style={{
                        color: "white",
                        border: "1px solid #059669",
                        background: "#059669",
                        padding: "0.25rem 0.5rem",
                        borderRadius: "0.25rem",
                        cursor: "pointer",
                      }}
                    >
                      Gmail 連携
                    </button>
                  )
                )}
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
            );
          })
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
