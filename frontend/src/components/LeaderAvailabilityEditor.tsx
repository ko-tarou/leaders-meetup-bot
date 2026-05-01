import { useState } from "react";
import type { EventAction } from "../types";
import { api } from "../api";
import { WeekCalendarPicker } from "./WeekCalendarPicker";

// Sprint 19 PR1: 管理画面 (member_application > 候補日時設定 サブタブ) で使う。
// kota が空き時間を週カレンダーでマークし、event_actions.config の
// leaderAvailableSlots に保存する。公開応募ページはこの値を取得して
// WeekCalendarPicker.restrictTo に渡し、応募者の選択肢を絞る。
type Props = {
  eventId: string;
  action: EventAction;
  onChange: () => void;
};

function parseInitialSlots(configRaw: string | null | undefined): string[] {
  try {
    const cfg = JSON.parse(configRaw || "{}");
    if (Array.isArray(cfg.leaderAvailableSlots)) {
      return cfg.leaderAvailableSlots.filter(
        (s: unknown): s is string => typeof s === "string",
      );
    }
    return [];
  } catch {
    return [];
  }
}

export function LeaderAvailabilityEditor({ eventId, action, onChange }: Props) {
  const [slots, setSlots] = useState<string[]>(() =>
    parseInitialSlots(action.config),
  );
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setError(null);
    setSaving(true);
    try {
      let cfg: Record<string, unknown> = {};
      try {
        cfg = JSON.parse(action.config || "{}");
        if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) {
          cfg = {};
        }
      } catch {
        cfg = {};
      }
      cfg.leaderAvailableSlots = slots;
      await api.events.actions.update(eventId, action.id, {
        config: JSON.stringify(cfg),
      });
      setSavedAt(new Date().toISOString());
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ padding: "1rem" }}>
      <h3 style={{ marginTop: 0 }}>面談可能な候補日時を設定</h3>
      <p
        style={{
          color: "#6b7280",
          fontSize: "0.875rem",
          marginBottom: "1rem",
        }}
      >
        リーダー側の空いている時間帯をクリックでマークしてください
        （応募者にはここで選択された時間帯のみが選択可能候補として表示されます）。
      </p>

      {error && (
        <div
          role="alert"
          style={{
            color: "#dc2626",
            marginBottom: "0.5rem",
            fontSize: "0.875rem",
          }}
        >
          {error}
        </div>
      )}

      <WeekCalendarPicker selectedSlots={slots} onChange={setSlots} />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          marginTop: "1rem",
        }}
      >
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          style={{
            background: saving ? "#93c5fd" : "#2563eb",
            color: "white",
            border: "none",
            padding: "0.5rem 1.5rem",
            borderRadius: "0.375rem",
            cursor: saving ? "not-allowed" : "pointer",
            fontSize: "0.875rem",
          }}
        >
          {saving ? "保存中..." : "保存"}
        </button>
        {savedAt && (
          <span style={{ fontSize: "0.875rem", color: "#16a34a" }}>
            ✓ 保存しました
          </span>
        )}
      </div>
    </div>
  );
}
