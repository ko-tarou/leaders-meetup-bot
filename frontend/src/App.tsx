import { useEffect, useState, type ReactNode } from "react";
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
import {
  EventSidebar,
  EventSidebarContent,
} from "./components/EventSidebar";
import { FeedbackWidget } from "./components/feedback/FeedbackWidget";
import { ConfirmProvider } from "./components/ui/ConfirmDialog";
import { ToastProvider } from "./components/ui/Toast";
import { EventProvider, useEvents } from "./contexts/EventContext";
import { useIsMobile } from "./hooks/useIsMobile";
import {
  clearPublicGranted,
  clearPublicMode,
  type PublicGranted,
  type PublicMode,
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
import { ParticipationFormPage } from "./pages/ParticipationFormPage";
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
    pathname.startsWith("/participation") ||
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
            <Route
              path="/participation/:eventId"
              element={<ParticipationFormPage />}
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
//
// UX 改善 Phase 1 - PR1:
// 旧 EventSwitcher (上部 dropdown) を廃止し、desktop は 2 カラム (左 = サイドバー /
// 右 = main) のレイアウトに変更。mobile は従来通り Header + ハンバーガーで、
// ドロワーシート内にサイドバー内容を埋め込む。
// 公開モード時は EventSidebar を出さず (本来 event 切替の権限が無い)、
// 従来通り max-width 800 のセンタリングレイアウトを維持する。
function AppShell() {
  const { tokenInvalid, fetchError } = useEvents();
  const publicMode = usePublicMode();
  const granted = usePublicGranted();
  const isPublic = publicMode !== null;
  const isMobile = useIsMobile();
  if (tokenInvalid) {
    return <AdminTokenPrompt message={fetchError ?? undefined} />;
  }

  const routesEl =
    isPublic && granted ? (
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
    );

  // 右側の main column を組み立てる。中身は従来の max-width 800 センタリング。
  const mainColumn = (
    <main
      style={{
        flex: 1,
        minWidth: 0,
        maxWidth: 800,
        // desktop で sidebar と本文の間に余白を入れる。mobile は中央寄せ。
        margin: isMobile || isPublic ? "0 auto" : "0 auto 0 0",
        width: "100%",
        // レスポンシブ: モバイル時は左右 padding を 12px に縮め、画面幅を有効活用。
        padding: isMobile ? "12px 12px 20px" : 20,
        fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
      }}
    >
      <AppHeader
        isMobile={isMobile}
        isPublic={isPublic}
        publicMode={publicMode}
      />
      {routesEl}
    </main>
  );

  // 公開モード / mobile: サイドバーは出さない (公開モードはそもそも event 切替不可。
  // mobile はハンバーガー drawer 内に EventSidebarContent を埋め込む)。
  if (isMobile || isPublic) {
    return mainColumn;
  }

  // desktop (admin): 左に EventSidebar、右に main を flex で並べる。
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        minHeight: "100vh",
        fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
      }}
    >
      <EventSidebar />
      {mainColumn}
    </div>
  );
}

// 共通ヘッダ。
// - desktop (>=640px): title + (公開モード時のみ) ログアウトを横並びで表示。
//   admin 時の event 切替は左サイドバー (EventSidebar) に移ったため、
//   ヘッダから EventSwitcher を撤去。Workspace管理 / 公開管理 リンクのみ残す。
// - mobile (<640px): title + ハンバーガーボタン。ナビはドロワーシート内で
//   EventSidebarContent + リンク類を縦並びで表示する。
// 公開モード時はサイドバーも出さないので、admin と同じく Header にリンクは出さず、
// ログアウトだけを出す既存仕様を維持する。
function AppHeader({
  isMobile,
  isPublic,
  publicMode,
}: {
  isMobile: boolean;
  isPublic: boolean;
  publicMode: PublicMode | null;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { pathname } = useLocation();

  // ルート遷移したらメニューは閉じる (drawer が開きっぱなしになる事故防止)
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  // メニュー open 中は body スクロールを止める (responsive.css の .rb-no-scroll)
  useEffect(() => {
    if (!menuOpen) return;
    document.body.classList.add("rb-no-scroll");
    return () => {
      document.body.classList.remove("rb-no-scroll");
    };
  }, [menuOpen]);

  // ESC でメニューを閉じる (a11y)
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  const titleEl = isPublic ? (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <h1 style={{ margin: 0, fontSize: isMobile ? 20 : 24 }}>DevHub Ops</h1>
      <span style={badgeStyle}>
        {publicMode === "view" ? "閲覧モード" : "編集モード"}
      </span>
    </div>
  ) : (
    <Link to="/" style={titleLinkStyle}>
      <h1 style={{ margin: 0, fontSize: isMobile ? 20 : 24 }}>DevHub Ops</h1>
    </Link>
  );

  // desktop の admin ヘッダ右側に出す管理リンク群 (event 切替は sidebar に移動済み)。
  const desktopAdminNav = (
    <>
      <Link to="/workspaces" style={workspacesLinkStyle}>
        Workspace管理
      </Link>
      <Link to="/public-management" style={workspacesLinkStyle}>
        公開管理
      </Link>
    </>
  );

  // desktop 側ヘッダ右の表示。公開モードは PublicLogoutButton、admin は管理リンク。
  const desktopNav = isPublic ? <PublicLogoutButton /> : desktopAdminNav;

  return (
    <header
      style={{
        marginBottom: isMobile ? 16 : 24,
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
        {titleEl}
        {isMobile ? (
          <button
            type="button"
            aria-label={menuOpen ? "メニューを閉じる" : "メニューを開く"}
            aria-expanded={menuOpen}
            aria-controls="app-mobile-menu"
            onClick={() => setMenuOpen((v) => !v)}
            style={hamburgerBtnStyle}
          >
            {/* 視覚的アイコンは ASCII で代替 (絵文字依存しない) */}
            <span aria-hidden="true" style={{ fontSize: 20, lineHeight: 1 }}>
              {menuOpen ? "✕" : "☰"}
            </span>
          </button>
        ) : (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            {desktopNav}
          </div>
        )}
      </div>
      <BackLink />
      {isMobile && menuOpen && (
        <MobileMenuSheet onClose={() => setMenuOpen(false)}>
          {isPublic ? (
            <PublicLogoutButton />
          ) : (
            <>
              {/* admin: drawer に EventSidebar 内容を埋め込む。
                  navigate でドロワーは自動で閉じる (pathname 変化を監視)。
                  onNavigate でも保険として閉じておく。 */}
              <EventSidebarContent
                variant="mobile"
                onNavigate={() => setMenuOpen(false)}
              />
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  marginTop: 12,
                  paddingTop: 12,
                  borderTop: `1px solid ${colors.border}`,
                }}
              >
                <Link
                  to="/workspaces"
                  style={mobileLinkStyle}
                  onClick={() => setMenuOpen(false)}
                >
                  Workspace管理
                </Link>
                <Link
                  to="/public-management"
                  style={mobileLinkStyle}
                  onClick={() => setMenuOpen(false)}
                >
                  公開管理
                </Link>
              </div>
            </>
          )}
        </MobileMenuSheet>
      )}
    </header>
  );
}

// レスポンシブ対応 PR1: モバイル時のドロワーシート。
// オーバーレイ + 右端から slide-in する画面の 80% 幅シートで、
// 中に EventSidebar 内容 / リンク類を縦並びで描画する。
function MobileMenuSheet({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        zIndex: 9990,
      }}
    >
      <aside
        id="app-mobile-menu"
        role="dialog"
        aria-modal="true"
        aria-label="メインメニュー"
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          height: "100%",
          width: "min(320px, 85vw)",
          background: colors.background,
          boxShadow: "-4px 0 12px rgba(0,0,0,0.15)",
          padding: "16px",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            marginBottom: 8,
          }}
        >
          <button
            type="button"
            aria-label="メニューを閉じる"
            onClick={onClose}
            style={hamburgerBtnStyle}
          >
            <span aria-hidden="true" style={{ fontSize: 20, lineHeight: 1 }}>
              ✕
            </span>
          </button>
        </div>
        {/* メニュー本体: 縦並びで tap target を確保 */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          {children}
        </div>
      </aside>
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

// drawer 内のフルワイドリンク。tap target 44px 以上を確保。
const mobileLinkStyle: React.CSSProperties = {
  display: "block",
  color: colors.primary,
  fontSize: 14,
  textDecoration: "none",
  padding: "12px 12px",
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: 6,
  background: colors.background,
  minHeight: 44,
};

// レスポンシブ対応 PR1: モバイルのハンバーガーボタン。
// tap target 44px 以上を確保し、a11y 用にコントラストの強い枠線を入れる。
const hamburgerBtnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 44,
  height: 44,
  padding: 0,
  background: colors.background,
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: 6,
  color: colors.text,
  cursor: "pointer",
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
