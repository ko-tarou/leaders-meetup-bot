import { Link, Route, Routes, useLocation } from "react-router-dom";
import { AdminTokenPrompt } from "./components/AdminTokenPrompt";
import { EventSwitcher } from "./components/EventSwitcher";
import { ConfirmProvider } from "./components/ui/ConfirmDialog";
import { ToastProvider } from "./components/ui/Toast";
import { EventProvider, useEvents } from "./contexts/EventContext";
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
import { colors } from "./styles/tokens";

export function App() {
  // /apply 配下は公開ページ（ヘッダー・EventProvider なし独立レイアウト）。
  // 公開ページでも将来トースト/確認ダイアログを使えるよう Provider は外側に置く。
  const { pathname } = useLocation();
  if (pathname.startsWith("/apply")) {
    return (
      <ToastProvider>
        <ConfirmProvider>
          <Routes>
            <Route path="/apply/:eventId" element={<PublicApplyPage />} />
            <Route
              path="/apply/:eventId/thanks"
              element={<PublicThanksPage />}
            />
          </Routes>
        </ConfirmProvider>
      </ToastProvider>
    );
  }

  // 005-7: ToastProvider / ConfirmProvider は EventProvider の外側に置く。
  // EventProvider 内の AdminTokenPrompt 経路でも (将来) トースト/確認が
  // 使えるようにするため。
  return (
    <ToastProvider>
      <ConfirmProvider>
        <EventProvider>
          <AppShell />
        </EventProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}

// 005-1: token 未設定 / 401 検出時は AdminTokenPrompt を最優先で表示する。
// useEvents は EventProvider 配下でしか使えないので、子コンポーネントとして分離。
function AppShell() {
  const { tokenInvalid, fetchError } = useEvents();
  if (tokenInvalid) {
    return <AdminTokenPrompt message={fetchError ?? undefined} />;
  }
  return (
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
          borderBottom: `1px solid ${colors.border}`,
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
  color: colors.primary,
  cursor: "pointer",
  padding: "4px 0",
  fontSize: 14,
  marginTop: 8,
  display: "inline-block",
  textDecoration: "none",
};

const workspacesLinkStyle: React.CSSProperties = {
  color: colors.primary,
  fontSize: 13,
  textDecoration: "none",
  padding: "6px 10px",
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: 4,
  background: colors.background,
  whiteSpace: "nowrap",
};
