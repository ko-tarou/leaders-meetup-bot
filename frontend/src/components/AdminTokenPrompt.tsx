import { useState, type FormEvent } from "react";
import { setAdminToken } from "../api";

/**
 * 005-1: admin Bearer トークン入力プロンプト。
 *
 * - localStorage に token がない、または 401 を検出した場合に表示
 * - 入力を `setAdminToken` で保存 → ページをリロードして再取得
 * - /apply 配下の公開ページでは表示しない（呼び出し側でガード）
 */
export function AdminTokenPrompt({ message }: { message?: string }) {
  const [value, setValue] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    setAdminToken(trimmed);
    window.location.reload();
  };

  return (
    <div
      role="dialog"
      aria-labelledby="admin-token-title"
      style={{
        maxWidth: 480,
        margin: "4rem auto",
        padding: "1.5rem 1.75rem",
        background: "#fff",
        border: "1px solid #ddd",
        borderRadius: 8,
        boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
        lineHeight: 1.6,
      }}
    >
      <h2
        id="admin-token-title"
        style={{ margin: 0, fontSize: 18, color: "#222" }}
      >
        管理トークンを入力してください
      </h2>
      <p style={{ marginTop: 8, color: "#555", fontSize: 14 }}>
        {message ??
          "DevHub Ops の admin API は Bearer トークン認証で保護されています。Cloudflare に登録済みの ADMIN_TOKEN を入力してください。"}
      </p>
      <form onSubmit={submit} style={{ marginTop: 12 }}>
        <input
          type="password"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="ADMIN_TOKEN"
          aria-label="ADMIN_TOKEN"
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "8px 10px",
            border: "1px solid #ccc",
            borderRadius: 4,
            fontSize: 14,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          }}
        />
        <button
          type="submit"
          disabled={!value.trim()}
          style={{
            marginTop: 12,
            padding: "8px 18px",
            border: "none",
            borderRadius: 4,
            cursor: value.trim() ? "pointer" : "not-allowed",
            fontSize: 14,
            background: value.trim() ? "#4A90D9" : "#bbb",
            color: "#fff",
          }}
        >
          保存して続行
        </button>
      </form>
      <p style={{ marginTop: 12, color: "#888", fontSize: 12 }}>
        トークンはこのブラウザの localStorage に保存されます。
      </p>
    </div>
  );
}
