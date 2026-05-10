import { MentionPicker } from "../MentionPicker";
import { AutoTextarea } from "../AutoTextarea";
import { colors } from "../../styles/tokens";
import {
  defaultCandidateRule,
  type AutoScheduleFrequency,
  type AutoScheduleCandidateRule,
} from "../../types";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

// monthly 既存挙動を維持するため、weekday/weeks/monthOffset は monthly 専用の値として
// candidateRule に保持し、weekly/yearly 用の値は別フィールドに展開する。
// poll start/close も frequency 別に別フィールドを保持し、save 時に必要な分だけ送る。
export type AutoScheduleConfig = {
  enabled: boolean;
  frequency: AutoScheduleFrequency;
  candidateRule: AutoScheduleCandidateRule;
  // monthly poll start/close (frequency=monthly のみ意味を持つ)
  pollStartDay: number;
  pollStartTime: string;
  pollCloseDay: number;
  pollCloseTime: string;
  // weekly poll start/close (frequency=weekly のみ意味を持つ)
  pollStartWeekday: number;
  pollCloseWeekday: number;
  // yearly poll start/close 用の月 (frequency=yearly のみ意味を持つ)
  // 日は pollStartDay/pollCloseDay を再利用
  pollStartMonth: number;
  pollCloseMonth: number;
  messageTemplate: string;
};

type Props = {
  meetingId: string;
  value: AutoScheduleConfig;
  onChange: (next: AutoScheduleConfig) => void;
};

export function AutoScheduleConfigPanel({ meetingId, value, onChange }: Props) {
  const patch = (p: Partial<AutoScheduleConfig>) => onChange({ ...value, ...p });

  const handleFrequencyChange = (freq: AutoScheduleFrequency) => {
    // frequency 切替時は candidateRule を default 値で初期化。
    // poll start/close の各値は frequency 専用なので「使わない値」は維持で良い。
    patch({ frequency: freq, candidateRule: defaultCandidateRule(freq) });
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
        <p style={{ margin: "4px 0 0 24px", color: colors.textSecondary, fontSize: 13 }}>
          ONにすると指定した頻度で自動的に投票開始・締切が行われます
        </p>
      </div>

      {/* 自動設定（enabled時のみ） */}
      {value.enabled && (
        <div style={cardStyle}>
          <h3 style={{ marginTop: 0 }}>自動スケジュール設定</h3>

          <div style={{ marginBottom: 16 }}>
            <label style={labelStyle}>頻度</label>
            <select
              value={value.frequency}
              onChange={(e) =>
                handleFrequencyChange(e.target.value as AutoScheduleFrequency)
              }
              style={inputStyle}
            >
              <option value="daily">毎日</option>
              <option value="weekly">毎週</option>
              <option value="monthly">毎月</option>
              <option value="yearly">毎年</option>
            </select>
          </div>

          {value.frequency === "daily" && (
            <DailyFields value={value} patch={patch} />
          )}
          {value.frequency === "weekly" && (
            <WeeklyFields value={value} patch={patch} />
          )}
          {value.frequency === "monthly" && (
            <MonthlyFields value={value} patch={patch} />
          )}
          {value.frequency === "yearly" && (
            <YearlyFields value={value} patch={patch} />
          )}
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
        <p style={{ margin: "4px 0 0", color: colors.textSecondary, fontSize: 12 }}>
          自動投票・手動投票の両方で使われます。空欄ならデフォルト文言。
        </p>
      </div>
    </>
  );
}

// === frequency 別のサブコンポーネント ===

type SubProps = {
  value: AutoScheduleConfig;
  patch: (p: Partial<AutoScheduleConfig>) => void;
};

function DailyFields({ value, patch }: SubProps) {
  // BE (src/services/auto-cycle.ts) は daily を「翌日固定」で扱う
  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>候補日</label>
        <p style={{ margin: "4px 0 0", color: colors.textSecondary, fontSize: 13 }}>
          翌日が候補日として自動生成されます
        </p>
      </div>
      <div style={{ display: "flex", gap: 16, marginBottom: 12, flexWrap: "wrap" }}>
        <div>
          <label style={labelStyle}>投票開始（毎日）</label>
          <input
            type="time"
            value={value.pollStartTime}
            onChange={(e) => patch({ pollStartTime: e.target.value })}
            style={{ ...inputStyle, width: 110 }}
          />
          <p style={timeHintStyle}>日本時間 (JST)</p>
        </div>
        <div>
          <label style={labelStyle}>投票締切（毎日）</label>
          <input
            type="time"
            value={value.pollCloseTime}
            onChange={(e) => patch({ pollCloseTime: e.target.value })}
            style={{ ...inputStyle, width: 110 }}
          />
          <p style={timeHintStyle}>日本時間 (JST)</p>
        </div>
      </div>
    </>
  );
}

function WeeklyFields({ value, patch }: SubProps) {
  const rule =
    value.candidateRule.type === "weekly"
      ? value.candidateRule
      : { type: "weekly" as const, weekday: 1, weeksAhead: 0 };
  const weeksAhead = rule.weeksAhead ?? 0;

  const patchRule = (next: Partial<typeof rule>) => {
    patch({ candidateRule: { ...rule, ...next } });
  };

  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>候補日の曜日</label>
        <select
          value={rule.weekday}
          onChange={(e) => patchRule({ weekday: Number(e.target.value) })}
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
        <label style={labelStyle}>対象週</label>
        <select
          value={weeksAhead}
          onChange={(e) => patchRule({ weeksAhead: Number(e.target.value) })}
          style={inputStyle}
        >
          <option value={0}>今週</option>
          <option value={1}>来週</option>
          <option value={2}>再来週</option>
          <option value={3}>3週間先</option>
        </select>
        <p style={{ margin: "4px 0 0", color: colors.textSecondary, fontSize: 12 }}>
          投票開始日を起点に、何週先の候補日にするか
        </p>
      </div>

      <div style={{ display: "flex", gap: 16, marginBottom: 12, flexWrap: "wrap" }}>
        <div>
          <label style={labelStyle}>投票開始（毎週）</label>
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <select
              value={value.pollStartWeekday}
              onChange={(e) => patch({ pollStartWeekday: Number(e.target.value) })}
              style={inputStyle}
            >
              {WEEKDAYS.map((name, i) => (
                <option key={i} value={i}>
                  {name}曜日
                </option>
              ))}
            </select>
            <input
              type="time"
              value={value.pollStartTime}
              onChange={(e) => patch({ pollStartTime: e.target.value })}
              style={{ ...inputStyle, width: 110 }}
            />
          </div>
          <p style={timeHintStyle}>日本時間 (JST)</p>
        </div>
        <div>
          <label style={labelStyle}>投票締切（毎週）</label>
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <select
              value={value.pollCloseWeekday}
              onChange={(e) => patch({ pollCloseWeekday: Number(e.target.value) })}
              style={inputStyle}
            >
              {WEEKDAYS.map((name, i) => (
                <option key={i} value={i}>
                  {name}曜日
                </option>
              ))}
            </select>
            <input
              type="time"
              value={value.pollCloseTime}
              onChange={(e) => patch({ pollCloseTime: e.target.value })}
              style={{ ...inputStyle, width: 110 }}
            />
          </div>
          <p style={timeHintStyle}>日本時間 (JST)</p>
        </div>
      </div>
    </>
  );
}

function MonthlyFields({ value, patch }: SubProps) {
  const rule =
    value.candidateRule.type === "weekday"
      ? value.candidateRule
      : { type: "weekday" as const, weekday: 6, weeks: [2, 3, 4], monthOffset: 0 };
  const monthOffset = rule.monthOffset ?? 0;

  const patchRule = (next: Partial<typeof rule>) => {
    patch({ candidateRule: { ...rule, ...next } });
  };

  const toggleWeek = (w: number) => {
    const next = rule.weeks.includes(w)
      ? rule.weeks.filter((x) => x !== w)
      : [...rule.weeks, w].sort();
    patchRule({ weeks: next });
  };

  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>候補日の曜日</label>
        <select
          value={rule.weekday}
          onChange={(e) => patchRule({ weekday: Number(e.target.value) })}
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
          value={monthOffset}
          onChange={(e) => patchRule({ monthOffset: Number(e.target.value) })}
          style={inputStyle}
        >
          <option value={0}>今月</option>
          <option value={1}>来月</option>
          <option value={2}>再来月</option>
          <option value={3}>3ヶ月先</option>
        </select>
        <p style={{ margin: "4px 0 0", color: colors.textSecondary, fontSize: 12 }}>
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
                border: `1px solid ${colors.borderStrong}`,
                borderRadius: 4,
                cursor: "pointer",
                background: rule.weeks.includes(w)
                  ? colors.primary
                  : colors.background,
                color: rule.weeks.includes(w) ? colors.textInverse : colors.text,
              }}
            >
              第{w}週
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", gap: 16, marginBottom: 12, flexWrap: "wrap" }}>
        <div>
          <label style={labelStyle}>投票開始（毎月）</label>
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input
              type="number"
              min={1}
              max={28}
              value={value.pollStartDay}
              onChange={(e) => patch({ pollStartDay: Number(e.target.value) })}
              style={{ ...inputStyle, width: 70 }}
            />
            <span style={{ color: colors.textSecondary }}>日</span>
            <input
              type="time"
              value={value.pollStartTime}
              onChange={(e) => patch({ pollStartTime: e.target.value })}
              style={{ ...inputStyle, width: 110 }}
            />
          </div>
          <p style={timeHintStyle}>日本時間 (JST)</p>
        </div>
        <div>
          <label style={labelStyle}>投票締切（毎月）</label>
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input
              type="number"
              min={1}
              max={28}
              value={value.pollCloseDay}
              onChange={(e) => patch({ pollCloseDay: Number(e.target.value) })}
              style={{ ...inputStyle, width: 70 }}
            />
            <span style={{ color: colors.textSecondary }}>日</span>
            <input
              type="time"
              value={value.pollCloseTime}
              onChange={(e) => patch({ pollCloseTime: e.target.value })}
              style={{ ...inputStyle, width: 110 }}
            />
          </div>
          <p style={timeHintStyle}>日本時間 (JST)</p>
        </div>
      </div>
    </>
  );
}

function YearlyFields({ value, patch }: SubProps) {
  const rule =
    value.candidateRule.type === "yearly"
      ? value.candidateRule
      : { type: "yearly" as const, month: 1, day: 1 };

  const patchRule = (next: Partial<typeof rule>) => {
    patch({ candidateRule: { ...rule, ...next } });
  };

  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>候補日</label>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <input
            type="number"
            min={1}
            max={12}
            value={rule.month}
            onChange={(e) => patchRule({ month: Number(e.target.value) })}
            style={{ ...inputStyle, width: 70 }}
          />
          <span style={{ color: colors.textSecondary }}>月</span>
          <input
            type="number"
            min={1}
            max={28}
            value={rule.day}
            onChange={(e) => patchRule({ day: Number(e.target.value) })}
            style={{ ...inputStyle, width: 70 }}
          />
          <span style={{ color: colors.textSecondary }}>日</span>
        </div>
      </div>

      <div style={{ display: "flex", gap: 16, marginBottom: 12, flexWrap: "wrap" }}>
        <div>
          <label style={labelStyle}>投票開始（毎年）</label>
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input
              type="number"
              min={1}
              max={12}
              value={value.pollStartMonth}
              onChange={(e) => patch({ pollStartMonth: Number(e.target.value) })}
              style={{ ...inputStyle, width: 70 }}
            />
            <span style={{ color: colors.textSecondary }}>月</span>
            <input
              type="number"
              min={1}
              max={28}
              value={value.pollStartDay}
              onChange={(e) => patch({ pollStartDay: Number(e.target.value) })}
              style={{ ...inputStyle, width: 70 }}
            />
            <span style={{ color: colors.textSecondary }}>日</span>
            <input
              type="time"
              value={value.pollStartTime}
              onChange={(e) => patch({ pollStartTime: e.target.value })}
              style={{ ...inputStyle, width: 110 }}
            />
          </div>
          <p style={timeHintStyle}>日本時間 (JST)</p>
        </div>
        <div>
          <label style={labelStyle}>投票締切（毎年）</label>
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input
              type="number"
              min={1}
              max={12}
              value={value.pollCloseMonth}
              onChange={(e) => patch({ pollCloseMonth: Number(e.target.value) })}
              style={{ ...inputStyle, width: 70 }}
            />
            <span style={{ color: colors.textSecondary }}>月</span>
            <input
              type="number"
              min={1}
              max={28}
              value={value.pollCloseDay}
              onChange={(e) => patch({ pollCloseDay: Number(e.target.value) })}
              style={{ ...inputStyle, width: 70 }}
            />
            <span style={{ color: colors.textSecondary }}>日</span>
            <input
              type="time"
              value={value.pollCloseTime}
              onChange={(e) => patch({ pollCloseTime: e.target.value })}
              style={{ ...inputStyle, width: 110 }}
            />
          </div>
          <p style={timeHintStyle}>日本時間 (JST)</p>
        </div>
      </div>
    </>
  );
}

const cardStyle: React.CSSProperties = {
  background: colors.surface,
  border: `1px solid ${colors.border}`,
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
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: 4,
};
const timeHintStyle: React.CSSProperties = {
  margin: "4px 0 0",
  color: colors.textSecondary,
  fontSize: 11,
};
