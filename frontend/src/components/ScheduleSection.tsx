import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { ReminderItem, AutoSchedule } from "../types";
import { AutoRespondSection } from "./AutoRespondSection";
import {
  AutoScheduleConfigPanel,
  type AutoScheduleConfig,
} from "./schedule/AutoScheduleConfigPanel";
import { RemindersPanel, withLocalIds } from "./schedule/RemindersPanel";
import { InstantSendPanel } from "./schedule/InstantSendPanel";
import { useToast } from "./ui/Toast";

type Props = { meetingId: string; onChange?: () => void };

const DEFAULT_REMINDERS: ReminderItem[] = [
  { trigger: { type: "before_event", daysBefore: 3 }, time: "09:00", message: "" },
  { trigger: { type: "before_event", daysBefore: 0 }, time: "09:00", message: "" },
];

const INITIAL_CONFIG: AutoScheduleConfig = {
  enabled: true,
  weekday: 6,
  weeks: [2, 3, 4],
  monthOffset: 0,
  pollStartDay: 1,
  pollStartTime: "00:00",
  pollCloseDay: 10,
  pollCloseTime: "00:00",
  messageTemplate: "",
};

export function ScheduleSection({ meetingId, onChange }: Props) {
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
        const candidate = data.candidateRule;
        setConfig({
          enabled: data.enabled === 1,
          weekday: candidate?.weekday ?? INITIAL_CONFIG.weekday,
          weeks: candidate?.weeks ?? INITIAL_CONFIG.weeks,
          monthOffset:
            candidate?.monthOffset ?? INITIAL_CONFIG.monthOffset,
          pollStartDay: data.pollStartDay,
          pollStartTime: data.pollStartTime || "00:00",
          pollCloseDay: data.pollCloseDay,
          pollCloseTime: data.pollCloseTime || "00:00",
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
        } else if (
          data.reminderDaysBefore &&
          Array.isArray(data.reminderDaysBefore)
        ) {
          const migrated: ReminderItem[] = data.reminderDaysBefore
            .map((item): ReminderItem | null => {
              if (typeof item === "number") {
                return {
                  trigger: { type: "before_event", daysBefore: item },
                  time: data.reminderTime ?? "09:00",
                  message: data.reminderMessageTemplate ?? "",
                };
              }
              if (item && typeof item === "object") {
                const daysBefore = Number(item.daysBefore);
                if (isNaN(daysBefore)) return null;
                return {
                  trigger: { type: "before_event", daysBefore },
                  time: data.reminderTime ?? "09:00",
                  message: item.message ?? data.reminderMessageTemplate ?? "",
                };
              }
              return null;
            })
            .filter((r): r is ReminderItem => r !== null);
          if (migrated.length > 0) setReminders(withLocalIds(migrated));
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

    const data = {
      candidateRule: {
        type: "weekday" as const,
        weekday: config.weekday,
        weeks: config.weeks,
        monthOffset: config.monthOffset,
      },
      pollStartDay: config.pollStartDay,
      pollStartTime: config.pollStartTime,
      pollCloseDay: config.pollCloseDay,
      pollCloseTime: config.pollCloseTime,
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

  return (
    <div>
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

      <RemindersPanel
        meetingId={meetingId}
        value={reminders}
        onChange={setReminders}
      />

      {/* 保存ボタン */}
      <div style={{ marginBottom: 24 }}>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            padding: "10px 24px",
            background: "#4A90D9",
            color: "#fff",
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

      <hr
        style={{ margin: "24px 0", border: "none", borderTop: "1px solid #eee" }}
      />

      {/* 手動アクション */}
      <h3>手動アクション</h3>
      <InstantSendPanel
        meetingId={meetingId}
        weekday={config.weekday}
        weeks={config.weeks}
        monthOffset={config.monthOffset}
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
    </div>
  );
}
