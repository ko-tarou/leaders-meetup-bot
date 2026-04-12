import { useState } from "react";
import { MeetingList } from "./components/MeetingList";
import { MeetingDetail } from "./components/MeetingDetail";

type Page = { type: "list" } | { type: "detail"; meetingId: string };

export function App() {
  const [page, setPage] = useState<Page>({ type: "list" });

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
          borderBottom: "1px solid #eee",
          paddingBottom: 12,
        }}
      >
        <h1 style={{ margin: 0, fontSize: 24 }}>Leaders Meetup Bot</h1>
        {page.type === "detail" && (
          <button
            onClick={() => setPage({ type: "list" })}
            style={linkStyle}
          >
            &#8592; ミーティング一覧に戻る
          </button>
        )}
      </header>
      {page.type === "list" && (
        <MeetingList
          onSelect={(id) => setPage({ type: "detail", meetingId: id })}
        />
      )}
      {page.type === "detail" && (
        <MeetingDetail
          meetingId={page.meetingId}
          onBack={() => setPage({ type: "list" })}
        />
      )}
    </div>
  );
}

const linkStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#4A90D9",
  cursor: "pointer",
  padding: "4px 0",
  fontSize: 14,
  marginTop: 8,
  display: "inline-block",
};
