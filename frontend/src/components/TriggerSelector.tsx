import type { Trigger } from "../types";
import { colors } from "../styles/tokens";

type Props = {
  trigger: Trigger;
  onChange: (trigger: Trigger) => void;
};

type Option = {
  type: Trigger["type"];
  label: string;
  hasParam: boolean;
  paramLabel?: string;
  min?: number;
  max?: number;
};

const TRIGGER_OPTIONS: Option[] = [
  { type: "before_event", label: "開催日の N 日前", hasParam: true, paramLabel: "日前", min: 0, max: 365 },
  { type: "after_event", label: "開催日の N 日後", hasParam: true, paramLabel: "日後", min: 0, max: 365 },
  { type: "after_poll_close", label: "投票締切の N 日後", hasParam: true, paramLabel: "日後", min: 0, max: 365 },
  { type: "day_of_month", label: "毎月 N 日", hasParam: true, paramLabel: "日", min: 1, max: 28 },
  { type: "on_poll_start", label: "投票開始時（即時）", hasParam: false },
  { type: "on_poll_close", label: "投票締切時（即時）", hasParam: false },
];

export function TriggerSelector({ trigger, onChange }: Props) {
  const option =
    TRIGGER_OPTIONS.find((o) => o.type === trigger.type) ?? TRIGGER_OPTIONS[0];

  const paramValue =
    trigger.type === "before_event"
      ? trigger.daysBefore
      : trigger.type === "after_event"
        ? trigger.daysAfter
        : trigger.type === "after_poll_close"
          ? trigger.daysAfter
          : trigger.type === "day_of_month"
            ? trigger.day
            : 0;

  const handleTypeChange = (newType: string) => {
    switch (newType) {
      case "before_event":
        onChange({ type: "before_event", daysBefore: 3 });
        break;
      case "after_event":
        onChange({ type: "after_event", daysAfter: 1 });
        break;
      case "after_poll_close":
        onChange({ type: "after_poll_close", daysAfter: 1 });
        break;
      case "day_of_month":
        onChange({ type: "day_of_month", day: 1 });
        break;
      case "on_poll_start":
        onChange({ type: "on_poll_start" });
        break;
      case "on_poll_close":
        onChange({ type: "on_poll_close" });
        break;
    }
  };

  const handleParamChange = (value: number) => {
    switch (trigger.type) {
      case "before_event":
        onChange({ type: "before_event", daysBefore: value });
        break;
      case "after_event":
        onChange({ type: "after_event", daysAfter: value });
        break;
      case "after_poll_close":
        onChange({ type: "after_poll_close", daysAfter: value });
        break;
      case "day_of_month":
        onChange({ type: "day_of_month", day: value });
        break;
    }
  };

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <select
        value={trigger.type}
        onChange={(e) => handleTypeChange(e.target.value)}
        style={inputStyle}
      >
        {TRIGGER_OPTIONS.map((o) => (
          <option key={o.type} value={o.type}>
            {o.label}
          </option>
        ))}
      </select>
      {option.hasParam && (
        <>
          <input
            type="number"
            min={option.min}
            max={option.max}
            value={paramValue}
            onChange={(e) => handleParamChange(Number(e.target.value))}
            style={{ ...inputStyle, width: 72 }}
          />
          <span style={{ fontSize: 13, color: colors.textSecondary }}>{option.paramLabel}</span>
        </>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "8px 12px",
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: 4,
};
