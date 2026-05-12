import type { ReactNode } from "react";
import {
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import { clearAdminToken } from "./api";
import { AdminTokenPrompt } from "./components/AdminTokenPrompt";
import { EventSwitcher } from "./components/EventSwitcher";
import { FeedbackWidget } from "./components/feedback/FeedbackWidget";
import { ConfirmProvider } from "./components/ui/ConfirmDialog";
import { ToastProvider } from "./components/ui/Toast";
import { EventProvider, useEvents } from "./contexts/EventContext";
import {
  clearPublicGranted,
  clearPublicMode,
  type PublicGranted,
  usePublicGranted,
  usePublicMode,
} from "./hooks/usePublicMode";
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
import { InterviewerFormPage } from "./pages/InterviewerFormPage";
import { PublicEntryPage } from "./pages/PublicEntryPage";
import { PublicManagementPage } from "./pages/PublicManagementPage";
import { WorkspacesPage } from "./pages/WorkspacesPage";
import { colors } from "./styles/tokens";

export function App() {
  // /apply 配下と /interviewer-form 配下は公開ページ
  // (ヘッダー・EventProvider なし独立レイアウト)。
  // - /apply 系: 応募者向け
  // - /interviewer-form 系 (005-interviewer-simplify / PR #139):
  //     面接官向け共有フォーム (token 認可、誰でもアクセス可・name で upsert)
  // 公開ページでも将来トースト/確認ダイアログを使えるよう Provider は外側に置く。
  const { pathname } = useLocation();
  if (
    pathname.startsWith("/apply") ||
    pathname.startsWith("/interviewer-form") ||
    pathname.startsWith("/public/")
  ) {
    return (
      <ToastProvider>
        <ConfirmProvider>
          <Routes>
            <Route path="/apply/:eventId" element={<PublicApplyPage />} />
            <Route
              path="/apply/:eventId/thanks"
              element={<PublicThanksPage />}
            />
            <Route
              path="/interviewer-form/:token"
              element={<InterviewerFormPage />}
            />
            <Route path="/public/:token" element={<PublicEntryPage />} />
          </Routes>
          {/* 005-feedback: 公開ページ (apply / interviewer-form / public)
              でも右下フィードバックウィジェットを表示する。 */}
          <FeedbackWidget />
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
        {/* 005-feedback: admin / 公開モード双方の通常 UI でも表示する。
            EventProvider の外側に置くことで AdminTokenPrompt が出ているときも
            ウィジェットからフィードバックを送れる。 */}
        <FeedbackWidget />
      </ConfirmProvider>
    </ToastProvider>
  );
}

// 005-1: token 未設定 / 401 検出時は AdminTokenPrompt を最優先で表示する。
// useEvents は EventProvider 配下でしか使えないので、子コンポーネントとして分離。
function AppShell() {
  const { tokenInvalid, fetchError } = useEvents();
  const publicMode = usePublicMode();
  const granted = usePublicGranted();
  const isPublic = publicMode !== null;
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
          {isPublic ? (
            // 公開モード時はタイトルをただのテキストにし、
            // EventSwitcher / Workspace管理 / 公開管理 などの navigation を隠す。
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <h1 style={{ margin: 0, fontSize: 24 }}>DevHub Ops</h1>
              <span style={badgeStyle}>
                {publicMode === "view" ? "閲覧モード" : "編集モード"}
              </span>
            </div>
          ) : (
            <Link to="/" style={titleLinkStyle}>
              <h1 style={{ margin: 0, fontSize: 24 }}>DevHub Ops</h1>
            </Link>
          )}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            {isPublic ? (
              <PublicLogoutButton />
            ) : (
              <>
                <EventSwitcher />
                <Link to="/workspaces" style={workspacesLinkStyle}>
                  Workspace管理
                </Link>
                <Link to="/public-management" style={workspacesLinkStyle}>
                  公開管理
                </Link>
              </>
            )}
          </div>
        </div>
        <BackLink />
      </header>
      {isPublic && granted ? (
        // 公開モード: granted の action のみアクセス可。
        // それ以外の URL に来た場合は granted action に redirect する。
        <Routes>
          <Route
            path="/events/:eventId/actions/:actionType"
            element={
              <PublicGuard granted={granted}>
                <ActionDetailPage />
              </PublicGuard>
            }
          />
          <Route
            path="*"
            element={
              <Navigate
                to={`/events/${granted.eventId}/actions/${granted.actionType}`}
                replace
              />
            }
          />
        </Routes>
      ) : (
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
          <Route path="/public-management" element={<PublicManagementPage />} />
        </Routes>
      )}
    </div>
  );
}

// 公開モード時の route ガード。
// URL の eventId / actionType が granted と一致しなければ granted action へ redirect。
function PublicGuard({
  granted,
  children,
}: {
  granted: PublicGranted;
  children: ReactNode;
}) {
  const { eventId, actionType } = useParams();
  if (eventId !== granted.eventId || actionType !== granted.actionType) {
    return (
      <Navigate
        to={`/events/${granted.eventId}/actions/${granted.actionType}`}
        replace
      />
    );
  }
  return <>{children}</>;
}

// 公開モードからのログアウトボタン。
// localStorage の public_mode / public_granted / admin_token をクリアして
// /public ログインページや本来の参照元に戻れる状態にする。
function PublicLogoutButton() {
  const navigate = useNavigate();
  const handleLogout = () => {
    clearPublicMode();
    clearPublicGranted();
    clearAdminToken();
    // ログアウト後はトップへ。token が無いので AdminTokenPrompt が出る。
    navigate("/", { replace: true });
    // localStorage の状態を確実に反映させるため reload する。
    window.location.reload();
  };
  return (
    <button
      type="button"
      onClick={handleLogout}
      style={{ ...workspacesLinkStyle, cursor: "pointer" }}
    >
      ログアウト
    </button>
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

const badgeStyle: React.CSSProperties = {
  fontSize: 12,
  padding: "2px 8px",
  borderRadius: 999,
  background: colors.surface,
  border: `1px solid ${colors.borderStrong}`,
  color: colors.textSecondary,
  whiteSpace: "nowrap",
};
