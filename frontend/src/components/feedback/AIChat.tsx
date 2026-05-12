/**
 * 005-feedback: Gemini 1.5 Flash を使った AI ヘルプチャット UI。
 *
 * 設計:
 *   - messages は FE 内 state のみ (永続化しない)。tab 切り替えで初期化される
 *     のは UX 上 OK と判断 (1 セッション内のヘルプ目的)。
 *   - 過去 N 件の履歴を毎回 API に送る (BE 側で 20 件まで trim)。
 *   - 送信中は input を disable、応答を待つ。
 *   - エラー時はチャット内に "エラー" メッセージを差し込んで UX を壊さない。
 */
import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { colors } from "../../styles/tokens";
import type { AIChatMessage } from "../../types";

export function AIChat() {
  const [messages, setMessages] = useState<AIChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // 新しいメッセージが追加されたら最下部にスクロール
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading]);

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || loading) return;
    const userMsg: AIChatMessage = { role: "user", content: trimmed };
    // history は「送信前まで」を送る。今送る user message は API 側で append される。
    const historyForApi = messages;
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);
    try {
      const res = await api.feedback.aiChat(trimmed, historyForApi);
      const reply = res.response ?? "(空の応答が返りました)";
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: reply },
      ]);
    } catch (e) {
      const errText =
        e instanceof Error
          ? `エラーが発生しました: ${e.message}`
          : "エラーが発生しました";
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: errText },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter のみで送信 (Shift+Enter は改行)。
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div style={styles.wrapper}>
      <div ref={scrollRef} style={styles.scroll}>
        {messages.length === 0 ? (
          <div style={styles.emptyBox}>
            <div style={{ fontSize: 28, marginBottom: 6 }}>🤖</div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              使い方を聞いてみましょう
            </div>
            <div
              style={{
                fontSize: 12,
                color: colors.textSecondary,
                lineHeight: 1.5,
              }}
            >
              例: 「日程調整の cron はどう設定する？」<br />
              例: 「公開 URL のパスワードはどこで変える？」
            </div>
          </div>
        ) : (
          messages.map((m, i) => (
            <div
              key={i}
              style={{
                ...styles.row,
                justifyContent: m.role === "user" ? "flex-end" : "flex-start",
              }}
            >
              <div
                style={{
                  ...styles.bubble,
                  background:
                    m.role === "user" ? colors.primary : colors.surface,
                  color:
                    m.role === "user" ? colors.textInverse : colors.text,
                  borderTopRightRadius: m.role === "user" ? 4 : 14,
                  borderTopLeftRadius: m.role === "user" ? 14 : 4,
                }}
              >
                <div style={styles.bubbleHeader}>
                  {m.role === "user" ? "🧑 あなた" : "🤖 AI"}
                </div>
                <div style={styles.bubbleText}>{m.content}</div>
              </div>
            </div>
          ))
        )}
        {loading && (
          <div style={{ ...styles.row, justifyContent: "flex-start" }}>
            <div
              style={{
                ...styles.bubble,
                background: colors.surface,
                color: colors.textSecondary,
                fontStyle: "italic",
              }}
            >
              考え中...
            </div>
          </div>
        )}
      </div>

      <div style={styles.inputRow}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="使い方を聞いてみる... (Enter で送信 / Shift+Enter で改行)"
          disabled={loading}
          rows={2}
          style={styles.input}
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={loading || !input.trim()}
          style={{
            ...styles.sendBtn,
            opacity: loading || !input.trim() ? 0.5 : 1,
            cursor: loading || !input.trim() ? "not-allowed" : "pointer",
          }}
        >
          送信
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 380,
  },
  scroll: {
    flex: 1,
    overflowY: "auto",
    padding: "8px 4px",
    display: "flex",
    flexDirection: "column",
    gap: 8,
    minHeight: 280,
    maxHeight: 380,
  },
  emptyBox: {
    margin: "auto",
    padding: 16,
    textAlign: "center",
  },
  row: {
    display: "flex",
    width: "100%",
  },
  bubble: {
    maxWidth: "82%",
    padding: "8px 12px",
    borderRadius: 14,
    fontSize: 13.5,
    lineHeight: 1.5,
    boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
  },
  bubbleHeader: {
    fontSize: 10.5,
    opacity: 0.75,
    marginBottom: 2,
    fontWeight: 600,
  },
  bubbleText: {
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  inputRow: {
    display: "flex",
    gap: 6,
    marginTop: 8,
    paddingTop: 8,
    borderTop: `1px solid ${colors.border}`,
  },
  input: {
    flex: 1,
    padding: "8px 10px",
    fontSize: 13.5,
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: 6,
    fontFamily: "inherit",
    resize: "none",
  },
  sendBtn: {
    padding: "8px 16px",
    fontSize: 13,
    fontWeight: 600,
    background: colors.primary,
    color: colors.textInverse,
    border: "none",
    borderRadius: 6,
  },
};
