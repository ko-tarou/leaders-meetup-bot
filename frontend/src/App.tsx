import { Link, Route, Routes, useLocation } from "react-router-dom";
import { EventSwitcher } from "./components/EventSwitcher";
import { EventProvider } from "./contexts/EventContext";
import { EventIndexRedirect } from "./pages/EventIndexRedirect";
import { EventTabPage } from "./pages/EventTabPage";
import { HomePage } from "./pages/HomePage";
import { MeetingDetailPage } from "./pages/MeetingDetailPage";

export function App() {
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
              <h1 style={{ margin: 0, fontSize: 24 }}>Leaders Meetup Bot</h1>
            </Link>
            <EventSwitcher />
          </div>
          <BackLink />
        </header>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/events/:eventId" element={<EventIndexRedirect />} />
          <Route path="/events/:eventId/:tab" element={<EventTabPage />} />
          <Route path="/meetings/:meetingId" element={<MeetingDetailPage />} />
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
