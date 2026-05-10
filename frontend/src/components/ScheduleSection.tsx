import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type {
  ReminderItem,
  AutoSchedule,
  AutoScheduleCandidateRule,
} from "../types";
import { AutoRespondSection } from "./AutoRespondSection";
import {
  AutoScheduleConfigPanel,
  type AutoScheduleConfig,
} from "./schedule/AutoScheduleConfigPanel";
import { RemindersPanel, withLocalIds } from "./schedule/RemindersPanel";
import { InstantSendPanel } from "./schedule/InstantSendPanel";
import { useToast } from "./ui/Toast";
import { colors } from "../styles/tokens";

// Sprint 005-tabs: schedule_polling を 5 sub-tab に再編する際の panel 切替。
//   - "config"   : AutoScheduleConfigPanel + AutoRespondSection（候補設定タブ）
//   - "reminders": RemindersPanel（リマインド設定タブ）
//   - "instant"  : InstantSendPanel + 締切ボタン（手動アクションタブ）
// panels を省略すると従来挙動（全 panel を 1 ページに表示）になる。
// 保存ボタンは "config" / "reminders" のいずれかが含まれる場合のみ表示し、
// 保存対象は常に backend 側の AutoSchedule 全体（部分保存ではない）。
type SchedulePanel = "config" | "reminders" | "instant";

type Props = {
  meetingId: string;
  onChange?: () => void;
  panels?: SchedulePanel[];
};

const DEFAULT_REMINDERS: ReminderItem[] = [
  { trigger: { type: "before_event", daysBefore: 3 }, time: "09:00", message: "" },
  { trigger: { type: "before_event", daysBefore: 0 }, time: "09:00", message: "" },
];

const INITIAL_CONFIG: AutoScheduleConfig = {
  enabled: true,
  frequency: "monthly",
  candidateRule: { type: "weekday", weekday: 6, weeks: [2, 3, 4], monthOffset: 0 },
  pollStartDay: 1,
  pollStartTime: "00:00",
  pollCloseDay: 10,
  pollCloseTime: "00:00",
  // weekly default (月曜)
  pollStartWeekday: 1,
  pollCloseWeekday: 1,
  // yearly default (1月1日)
  pollStartMonth: 1,
  pollCloseMonth: 1,
  messageTemplate: "",
};

/** monthly 既存挙動用: candidateRule.type === "weekday" を取り出す。InstantSendPanel が利用。 */
function extractMonthlyRule(rule: AutoScheduleCandidateRule): {
  weekday: number;
  weeks: number[];
  monthOffset: number;
} {
  if (rule.type === "weekday") {
    return {
      weekday: rule.weekday,
      weeks: rule.weeks,
      monthOffset: rule.monthOffset ?? 0,
    };
  }
  return { weekday: 6, weeks: [2, 3, 4], monthOffset: 0 };
}

const ALL_PANELS: SchedulePanel[] = ["config", "reminders", "instant"];

export function ScheduleSection({ meetingId, onChange, panels }: Props) {
  const visible = panels ?? ALL_PANELS;
  const showConfig = visible.includes("config");
  const showReminders = visible.includes("reminders");
  const showInstant = visible.includes("instant");
  // 保存対象を含む panel が表示されているときだけ「設定を保存」ボタンを出す
  const showSave = showConfig || showReminders;
  const toast = useToast();
  const [schedule, setSchedule] = useState<AutoSchedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasOpenPoll, setHasOpenPoll] = useState(false);
  const [saving, setSaving] = useState(false);

  const [config, setConfig] = useState<AutoScheduleConfig>(INITIAL_CONFIG);
  const [reminders, setReminders] = useState<ReminderItem[]>(() =>
    withLocalIds(DEFAULT_REMINDERS),
  );

  const [autoRespondEnabled, setAutoRespondEnabled] = useState(false);
  const [autoRespondTemplate, setAutoRespondTemplate] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await api.getAutoSchedule(meetingId);
      if (data && data.id) {
        setSchedule(data);
        // frequency 未指定の既存行は monthly として扱う。
        const freq = data.frequency ?? "monthly";
        const candidate: AutoScheduleCandidateRule =
          data.candidateRule ?? INITIAL_CONFIG.candidateRule;
        setConfig({
          enabled: data.enabled === 1,
          frequency: freq,
          candidateRule: candidate,
          pollStartDay: data.pollStartDay,
          pollStartTime: data.pollStartTime || "00:00",
          pollCloseDay: data.pollCloseDay,
          pollCloseTime: data.pollCloseTime || "00:00",
          pollStartWeekday:
            data.pollStartWeekday ?? INITIAL_CONFIG.pollStartWeekday,
          pollCloseWeekday:
            data.pollCloseWeekday ?? INITIAL_CONFIG.pollCloseWeekday,
          pollStartMonth: data.pollStartMonth ?? INITIAL_CONFIG.pollStartMonth,
          pollCloseMonth: data.pollCloseMonth ?? INITIAL_CONFIG.pollCloseMonth,
          messageTemplate: data.messageTemplate ?? "",
        });
        setAutoRespondEnabled(data.autoRespondEnabled === 1);
        setAutoRespondTemplate(data.autoRespondTemplate ?? "");
        if (Array.isArray(data.reminders) && data.reminders.length > 0) {
          setReminders(
            withLocalIds(
              data.reminders.map((r) => ({
                trigger: r.trigger,
                time: r.time,
                message: r.message ?? "",
              })),
            ),
          );
        }
      }
    } catch {
      // 未設定
    }
    try {
      const pollList = await api.getPolls(meetingId);
      setHasOpenPoll(pollList.some((p) => p.status === "open"));
    } catch {
      setHasOpenPoll(false);
    }
    setLoading(false);
  }, [meetingId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = async () => {
    setSaving(true);
    // ローカル ID は backend に送らない
    const normalized: ReminderItem[] = reminders.map((r) => ({
      trigger: r.trigger,
      time: r.time,
      message: r.message && r.message.trim() !== "" ? r.message : null,
    }));

    // frequency 別に「使うフィールド」のみ payload に含める。
    // BE 側は使わないフィールドを無視 or null 維持してくれる (POST は default 値で埋める)。
    const freq = config.frequency;
    const data = {
      frequency: freq,
      candidateRule: config.candidateRule,
      pollStartTime: config.pollStartTime,
      pollCloseTime: config.pollCloseTime,
      // monthly / yearly は day を使う
      pollStartDay:
        freq === "monthly" || freq === "yearly" ? config.pollStartDay : 1,
      pollCloseDay:
        freq === "monthly" || freq === "yearly" ? config.pollCloseDay : 1,
      // weekly は weekday を使う
      pollStartWeekday: freq === "weekly" ? config.pollStartWeekday : null,
      pollCloseWeekday: freq === "weekly" ? config.pollCloseWeekday : null,
      // yearly は month を使う
      pollStartMonth: freq === "yearly" ? config.pollStartMonth : null,
      pollCloseMonth: freq === "yearly" ? config.pollCloseMonth : null,
      reminders: normalized,
      messageTemplate: config.messageTemplate.trim()
        ? config.messageTemplate
        : null,
      autoRespondEnabled: autoRespondEnabled ? 1 : 0,
      autoRespondTemplate: autoRespondTemplate.trim()
        ? autoRespondTemplate
        : null,
    };

    try {
      if (schedule) {
        await api.updateAutoSchedule(schedule.id, {
          ...data,
          enabled: config.enabled ? 1 : 0,
        });
      } else {
        await api.createAutoSchedule(meetingId, data);
        // 新規作成時に enabled=false が指定された場合は直後に更新
        if (!config.enabled) {
          const created = await api.getAutoSchedule(meetingId);
          if (created && created.id) {
            await api.updateAutoSchedule(created.id, { enabled: 0 });
          }
        }
      }
      await load();
      onChange?.();
    } catch {
      toast.error("保存に失敗しました");
    }
    setSaving(false);
  };

  if (loading) return <p>読み込み中...</p>;

  // config と instant の両方を表示するときだけ区切り線を出す（旧挙動互換）
  const showDivider = showInstant && (showConfig || showReminders);

  return (
    <div>
      {showConfig && (
        <>
          <AutoScheduleConfigPanel
            meetingId={meetingId}
            value={config}
            onChange={setConfig}
          />

          <AutoRespondSection
            meetingId={meetingId}
            enabled={autoRespondEnabled}
            template={autoRespondTemplate}
            onEnabledChange={setAutoRespondEnabled}
            onTemplateChange={setAutoRespondTemplate}
          />
        </>
      )}

      {showReminders && (
        <RemindersPanel
          meetingId={meetingId}
          value={reminders}
          onChange={setReminders}
        />
      )}

      {/* 保存ボタン: config / reminders のいずれかが表示されているときのみ */}
      {showSave && (
        <div style={{ marginBottom: 24 }}>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              padding: "10px 24px",
              background: colors.primary,
              color: colors.textInverse,
              border: "none",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            {saving ? "保存中..." : "設定を保存"}
          </button>
        </div>
      )}

      {showDivider && (
        <hr
          style={{ margin: "24px 0", border: "none", borderTop: `1px solid ${colors.border}` }}
        />
      )}

      {showInstant && (() => {
        // InstantSendPanel は monthly 前提 (週 + 月オフセット) のため、
        // candidateRule から monthly 値を抽出して渡す。非 monthly の場合は default 値。
        const monthly = extractMonthlyRule(config.candidateRule);
        return (
          <>
            {/* 手動アクション */}
            <h3>手動アクション</h3>
            <InstantSendPanel
              meetingId={meetingId}
              weekday={monthly.weekday}
              weeks={monthly.weeks}
              monthOffset={monthly.monthOffset}
              messageTemplate={config.messageTemplate}
              hasOpenPoll={hasOpenPoll}
              onAfterSend={async () => {
                await load();
                onChange?.();
              }}
              onAfterClose={async () => {
                await load();
                onChange?.();
              }}
            />
          </>
        );
      })()}
    </div>
  );
}
