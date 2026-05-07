import { MentionPicker } from "../MentionPicker";
import { AutoTextarea } from "../AutoTextarea";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

export type AutoScheduleConfig = {
  enabled: boolean;
  weekday: number;
  weeks: number[];
  monthOffset: number;
  pollStartDay: number;
  pollStartTime: string;
  pollCloseDay: number;
  pollCloseTime: string;
  messageTemplate: string;
};

type Props = {
  meetingId: string;
  value: AutoScheduleConfig;
  onChange: (next: AutoScheduleConfig) => void;
};

export function AutoScheduleConfigPanel({ meetingId, value, onChange }: Props) {
  const patch = (p: Partial<AutoScheduleConfig>) => onChange({ ...value, ...p });

  const toggleWeek = (w: number) => {
    const next = value.weeks.includes(w)
      ? value.weeks.filter((x) => x !== w)
      : [...value.weeks, w].sort();
    patch({ weeks: next });
  };

  const handleInsertMention = (text: string) => {
    const prev = value.messageTemplate;
    const next =
      prev.endsWith(" ") || prev === ""
        ? prev + text + " "
        : prev + " " + text + " ";
    patch({ messageTemplate: next });
  };

  return (
    <>
      {/* 自動スケジュール ON/OFF */}
      <div style={cardStyle}>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            cursor: "pointer",
            fontWeight: 600,
          }}
        >
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />
          自動スケジュールを有効にする
        </label>
        <p style={{ margin: "4px 0 0 24px", color: "#666", fontSize: 13 }}>
          ONにすると毎月自動で投票開始・締切が行われます
        </p>
      </div>

      {/* 自動設定（enabled時のみ） */}
      {value.enabled && (
        <div style={cardStyle}>
          <h3 style={{ marginTop: 0 }}>自動スケジュール設定</h3>

          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>候補日の曜日</label>
            <select
              value={value.weekday}
              onChange={(e) => patch({ weekday: Number(e.target.value) })}
              style={inputStyle}
            >
              {WEEKDAYS.map((name, i) => (
                <option key={i} value={i}>
                  {name}曜日
                </option>
              ))}
            </select>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>対象月</label>
            <select
              value={value.monthOffset}
              onChange={(e) => patch({ monthOffset: Number(e.target.value) })}
              style={inputStyle}
            >
              <option value={0}>今月</option>
              <option value={1}>来月</option>
              <option value={2}>再来月</option>
              <option value={3}>3ヶ月先</option>
            </select>
            <p style={{ margin: "4px 0 0", color: "#666", fontSize: 12 }}>
              投票開始日を起点に、何ヶ月先のイベント日程を候補にするか
            </p>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>第何週を候補にするか</label>
            <div style={{ display: "flex", gap: 8 }}>
              {[1, 2, 3, 4, 5].map((w) => (
                <button
                  key={w}
                  onClick={() => toggleWeek(w)}
                  type="button"
                  style={{
                    padding: "8px 12px",
                    border: "1px solid #ddd",
                    borderRadius: 4,
                    cursor: "pointer",
                    background: value.weeks.includes(w) ? "#4A90D9" : "#fff",
                    color: value.weeks.includes(w) ? "#fff" : "#333",
                  }}
                >
                  第{w}週
                </button>
              ))}
            </div>
          </div>

          <div
            style={{ display: "flex", gap: 16, marginBottom: 12, flexWrap: "wrap" }}
          >
            <div>
              <label style={labelStyle}>投票開始（毎月）</label>
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <input
                  type="number"
                  min={1}
                  max={28}
                  value={value.pollStartDay}
                  onChange={(e) =>
                    patch({ pollStartDay: Number(e.target.value) })
                  }
                  style={{ ...inputStyle, width: 70 }}
                />
                <span style={{ color: "#666" }}>日</span>
                <input
                  type="time"
                  value={value.pollStartTime}
                  onChange={(e) => patch({ pollStartTime: e.target.value })}
                  style={{ ...inputStyle, width: 110 }}
                />
              </div>
              <p style={{ margin: "4px 0 0", color: "#666", fontSize: 11 }}>
                日本時間 (JST)
              </p>
            </div>
            <div>
              <label style={labelStyle}>投票締切（毎月）</label>
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <input
                  type="number"
                  min={1}
                  max={28}
                  value={value.pollCloseDay}
                  onChange={(e) =>
                    patch({ pollCloseDay: Number(e.target.value) })
                  }
                  style={{ ...inputStyle, width: 70 }}
                />
                <span style={{ color: "#666" }}>日</span>
                <input
                  type="time"
                  value={value.pollCloseTime}
                  onChange={(e) => patch({ pollCloseTime: e.target.value })}
                  style={{ ...inputStyle, width: 110 }}
                />
              </div>
              <p style={{ margin: "4px 0 0", color: "#666", fontSize: 11 }}>
                日本時間 (JST)
              </p>
            </div>
          </div>
        </div>
      )}

      {/* メッセージ本文（共通） */}
      <div style={cardStyle}>
        <label style={labelStyle}>投票メッセージ本文</label>
        <MentionPicker meetingId={meetingId} onInsert={handleInsertMention} />
        <AutoTextarea
          value={value.messageTemplate}
          onChange={(e) => patch({ messageTemplate: e.target.value })}
          placeholder=":tada: 今月のリーダー雑談会の日程調整です！"
          minRows={3}
          style={{
            ...inputStyle,
            width: "100%",
            resize: "vertical",
            fontFamily: "inherit",
            boxSizing: "border-box",
          }}
        />
        <p style={{ margin: "4px 0 0", color: "#666", fontSize: 12 }}>
          自動投票・手動投票の両方で使われます。空欄ならデフォルト文言。
        </p>
      </div>
    </>
  );
}

const cardStyle: React.CSSProperties = {
  background: "#f9f9f9",
  border: "1px solid #eee",
  borderRadius: 8,
  padding: 16,
  marginBottom: 16,
};
const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 14,
  fontWeight: "bold",
  marginBottom: 4,
};
const inputStyle: React.CSSProperties = {
  padding: "8px 12px",
  border: "1px solid #ddd",
  borderRadius: 4,
};
