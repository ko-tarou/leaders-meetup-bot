/**
 * 005-feedback: 右下に常駐するフィードバックウィジェット。
 *
 * - admin / 公開モード / public ページ (apply 等) 全てで表示する。
 * - 2 タブ:
 *     1. 💡 改善要望・バグ報告 → Slack 通知
 *     2. 💬 使い方を聞く (AI) → Gemini で応答
 * - 右下 floating ボタンをクリックでモーダル開閉。
 * - widget を open した時に GET /api/feedback/status を fetch して
 *   feedbackEnabled / aiChatEnabled を取得し、無効化されているタブには
 *   「設定でオフになっています」の案内を表示する (送信ボタンは出さない)。
 *
 * 設計判断:
 *   - status fetch は 1 度開いたら cache する (open 時に未取得なら fetch)。
 *   - fetch 失敗時は両方 true として扱う (= 従来挙動)。送信時に BE が
 *     no-op or 403 を返すので、fail-soft で UX を壊さない。
 */
import { useEffect, useState } from "react";
import { api } from "../../api";
import { colors } from "../../styles/tokens";
import { AIChat } from "./AIChat";
import { FeedbackForm } from "./FeedbackForm";

type Tab = "feedback" | "ai";

type Status = { feedbackEnabled: boolean; aiChatEnabled: boolean };

export function FeedbackWidget() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("feedback");
  // status: null = まだ未取得 (open するまで fetch しない)。
  // 取得済みなら以降は再 fetch しない (widget 1 セッション 1 fetch)。
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    if (!open || status !== null) return;
    let cancelled = false;
    api.feedback
      .getStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        // fail-safe: 取得失敗時は両方 true として従来挙動を維持する。
        if (!cancelled) {
          setStatus({ feedbackEnabled: true, aiChatEnabled: true });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, status]);

  // status 未取得時 (= 初回 open 直後の極短時間) は両方 true として描画する。
  // BE が返す前に「オフです」と一瞬出るのを避ける。
  const effective: Status = status ?? {
    feedbackEnabled: true,
    aiChatEnabled: true,
  };

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="フィードバック"
          title="フィードバック・使い方を聞く"
          style={fabStyle}
        >
          💬
        </button>
      )}

      {open && (
        <>
          {/* overlay は背景クリックで閉じる */}
          <div
            role="presentation"
            onClick={() => setOpen(false)}
            style={overlayStyle}
          />
          <div role="dialog" aria-label="フィードバック" style={modalStyle}>
            <header style={headerStyle}>
              <div style={{ fontWeight: 700, fontSize: 16 }}>
                フィードバック
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="閉じる"
                style={closeBtnStyle}
              >
                ×
              </button>
            </header>

            <div style={tabsStyle}>
              <TabButton
                active={tab === "feedback"}
                onClick={() => setTab("feedback")}
                label="💡 改善要望・バグ報告"
              />
              <TabButton
                active={tab === "ai"}
                onClick={() => setTab("ai")}
                label="💬 使い方を聞く (AI)"
              />
            </div>

            <div style={contentStyle}>
              {tab === "feedback" ? (
                <FeedbackForm enabled={effective.feedbackEnabled} />
              ) : (
                <AIChat enabled={effective.aiChatEnabled} />
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}

function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: 1,
        padding: "10px 4px",
        background: "transparent",
        border: "none",
        borderBottom: `2px solid ${active ? colors.primary : "transparent"}`,
        color: active ? colors.primary : colors.textSecondary,
        fontWeight: active ? 700 : 500,
        fontSize: 13,
        cursor: "pointer",
        transition: "color 0.15s",
      }}
    >
      {label}
    </button>
  );
}

const fabStyle: React.CSSProperties = {
  position: "fixed",
  bottom: 20,
  right: 20,
  width: 56,
  height: 56,
  borderRadius: "50%",
  background: colors.primary,
  color: colors.textInverse,
  border: "none",
  fontSize: 26,
  cursor: "pointer",
  boxShadow: "0 4px 12px rgba(0,0,0,0.18)",
  zIndex: 1000,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
};

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "transparent",
  zIndex: 1001,
};

const modalStyle: React.CSSProperties = {
  position: "fixed",
  bottom: 20,
  right: 20,
  width: "min(420px, calc(100vw - 40px))",
  maxHeight: "min(640px, calc(100vh - 40px))",
  background: colors.background,
  borderRadius: 12,
  boxShadow: "0 12px 36px rgba(0,0,0,0.18)",
  border: `1px solid ${colors.border}`,
  zIndex: 1002,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "12px 14px",
  borderBottom: `1px solid ${colors.border}`,
  background: colors.surface,
};

const closeBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  fontSize: 22,
  lineHeight: 1,
  cursor: "pointer",
  color: colors.textSecondary,
  padding: "0 6px",
};

const tabsStyle: React.CSSProperties = {
  display: "flex",
  borderBottom: `1px solid ${colors.border}`,
};

const contentStyle: React.CSSProperties = {
  flex: 1,
  padding: 14,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
};
