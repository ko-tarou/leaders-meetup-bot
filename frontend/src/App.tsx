import { useState, useEffect } from "react";
import { api } from "./api";
import type { Meeting } from "./types";

export function App() {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getMeetings().then((data) => {
      setMeetings(data);
      setLoading(false);
    });
  }, []);

  return (
    <div
      style={{
        maxWidth: 800,
        margin: "0 auto",
        padding: 20,
        fontFamily: "sans-serif",
      }}
    >
      <h1>Leaders Meetup Bot</h1>
      <p>管理画面</p>
      {loading ? (
        <p>読み込み中...</p>
      ) : (
        <div>
          <h2>ミーティング一覧</h2>
          {meetings.length === 0 ? (
            <p>ミーティングがありません</p>
          ) : (
            <ul>
              {meetings.map((m) => (
                <li key={m.id}>
                  {m.name} ({m.channelId})
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
