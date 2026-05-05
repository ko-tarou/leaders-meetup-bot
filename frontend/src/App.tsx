import { Link, Route, Routes, useLocation } from "react-router-dom";
import { EventSwitcher } from "./components/EventSwitcher";
import { EventProvider } from "./contexts/EventContext";
import { ActionDetailPage } from "./pages/ActionDetailPage";
import { EventIndexRedirect } from "./pages/EventIndexRedirect";
import { EventTabPage } from "./pages/EventTabPage";
import { HomePage } from "./pages/HomePage";
import { MeetingDetailPage } from "./pages/MeetingDetailPage";
import { WeeklyReminderDetailPage } from "./pages/WeeklyReminderDetailPage";
import {
  PublicApplyPage,
  PublicThanksPage,
} from "./pages/PublicApplyPage";
import { WorkspacesPage } from "./pages/WorkspacesPage";

export function App() {
  // /apply 配下は公開ページ（ヘッダー・EventProvider なし独立レイアウト）
  const { pathname } = useLocation();
  if (pathname.startsWith("/apply")) {
    return (
      <Routes>
        <Route path="/apply/:eventId" element={<PublicApplyPage />} />
        <Route
          path="/apply/:eventId/thanks"
          element={<PublicThanksPage />}
        />
      </Routes>
    );
  }

  return (
    <EventProvider>
      <div
        style={{
          maxWidth: 800,
          margin: "0 auto",
          padding: 20,
          fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
        }}
      >
        <header
          style={{
            marginBottom: 24,
            borderBottom: "1px solid #eee",
            paddingBottom: 12,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <Link to="/" style={titleLinkStyle}>
              <h1 style={{ margin: 0, fontSize: 24 }}>DevHub Ops</h1>
            </Link>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <EventSwitcher />
              <Link to="/workspaces" style={workspacesLinkStyle}>
                Workspace管理
              </Link>
            </div>
          </div>
          <BackLink />
        </header>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/events/:eventId" element={<EventIndexRedirect />} />
          {/* Sprint 23 PR-A: 週次リマインドの個別詳細ページ。
              より具体的なルートを上に置いてマッチを優先させる。 */}
          <Route
            path="/events/:eventId/actions/weekly_reminder/:reminderId"
            element={<WeeklyReminderDetailPage />}
          />
          {/* /actions/:actionType を /:tab より上に置いてマッチを優先させる */}
          <Route
            path="/events/:eventId/actions/:actionType"
            element={<ActionDetailPage />}
          />
          <Route path="/events/:eventId/:tab" element={<EventTabPage />} />
          <Route path="/meetings/:meetingId" element={<MeetingDetailPage />} />
          <Route path="/workspaces" element={<WorkspacesPage />} />
        </Routes>
      </div>
    </EventProvider>
  );
}

// 詳細表示時のみ「一覧に戻る」を描画 (旧 page.type==="detail" 分岐の URL 化)
function BackLink() {
  const { pathname } = useLocation();
  if (!pathname.startsWith("/meetings/")) return null;
  return (
    <Link to="/" style={linkStyle}>
      &#8592; ミーティング一覧に戻る
    </Link>
  );
}

const titleLinkStyle: React.CSSProperties = {
  textDecoration: "none",
  color: "inherit",
};

const linkStyle: React.CSSProperties = {
  color: "#4A90D9",
  cursor: "pointer",
  padding: "4px 0",
  fontSize: 14,
  marginTop: 8,
  display: "inline-block",
  textDecoration: "none",
};

const workspacesLinkStyle: React.CSSProperties = {
  color: "#4A90D9",
  fontSize: 13,
  textDecoration: "none",
  padding: "6px 10px",
  border: "1px solid #ddd",
  borderRadius: 4,
  background: "#fff",
  whiteSpace: "nowrap",
};
