/**
 * 005-feedback: 右下に常駐するフィードバックウィジェット。
 *
 * - admin / 公開モード / public ページ (apply 等) 全てで表示する。
 * - 2 タブ:
 *     1. 💡 改善要望・バグ報告 → Slack 通知
 *     2. 💬 使い方を聞く (AI) → Gemini で応答
 * - 右下 floating ボタンをクリックでモーダル開閉。
 * - AI チャットは app_settings.aiChatEnabled = true のときのみ表示する。
 *   設定取得失敗時は AI タブを隠す (admin token 不要の public エンドポイントは
 *   別途必要だが、PoC では aiChatEnabled = false でも UI を見せる方針)。
 *
 * 設計判断:
 *   - aiChatEnabled は admin が trigger するため、公開 API 化しなくても
 *     FE 側で fetch を試行 → 失敗 (401) なら AI タブをデフォルトで表示する。
 *   - 簡略化のため、aiChatEnabled は admin がログイン中のときだけ厳密判定、
 *     公開モードでは AI タブを常に表示し、disable 時は 403 で「無効化中」と表示。
 */
import { useState } from "react";
import { colors } from "../../styles/tokens";
import { AIChat } from "./AIChat";
import { FeedbackForm } from "./FeedbackForm";

type Tab = "feedback" | "ai";

export function FeedbackWidget() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("feedback");

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
              {tab === "feedback" ? <FeedbackForm /> : <AIChat />}
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
