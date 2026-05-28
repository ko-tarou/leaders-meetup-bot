import { useMemo, useState, type CSSProperties } from "react";
import type { EventAction } from "../../types";
import { request } from "../../api/client";
import { useToast } from "../ui/Toast";
import { colors } from "../../styles/tokens";

// 宗教イベント goal_reminder PR2: 目標リマインダーのメインタブ。
// 上部: 現在の設定サマリ (目標 / 朝夜時刻 / 頻度)。生 ID は一切出さない。
// 下部: 朝 / 夜の文面を「今すぐ送信」する 2 ボタン (テスト用)。
//   POST /orgs/:eventId/actions/:actionId/goal-reminder/send  body { slot }
//   not_configured (workspace/channel 未設定) は分かりやすい案内に変換する。

const DEFAULT_MORNING_TIME = "08:00";
const DEFAULT_NIGHT_TIME = "22:00";
const DEFAULT_GOAL_TEXT = "次世代の宗教を作る";

type Frequency = "daily" | "weekday";

type Config = {
  workspaceId?: string | null;
  channelId?: string | null;
  morningTime?: string;
  nightTime?: string;
  frequency?: Frequency;
  goalText?: string;
};

function parseConfig(raw: string | null | undefined): Config {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? (o as Config) : {};
  } catch {
    return {};
  }
}

export function GoalReminderMainTab({
  eventId,
  actionId,
  action,
}: {
  eventId: string;
  actionId: string;
  action: EventAction;
}) {
  const toast = useToast();
  const cfg = useMemo(() => parseConfig(action.config), [action.config]);
  const [busy, setBusy] = useState<"morning" | "night" | null>(null);

  const goalText = cfg.goalText && cfg.goalText.trim() !== "" ? cfg.goalText : DEFAULT_GOAL_TEXT;
  const morningTime = cfg.morningTime ?? DEFAULT_MORNING_TIME;
  const nightTime = cfg.nightTime ?? DEFAULT_NIGHT_TIME;
  const frequencyLabel = cfg.frequency === "weekday" ? "平日のみ" : "毎日";
  const configured = Boolean(cfg.workspaceId && cfg.channelId);

  async function send(slot: "morning" | "night") {
    setBusy(slot);
    try {
      await request(`/orgs/${eventId}/actions/${actionId}/goal-reminder/send`, {
        method: "POST",
        body: JSON.stringify({ slot }),
      });
      toast.success("送信しました");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("not_configured")) {
        toast.error("先に設定を保存してください");
      } else {
        toast.error(msg || "送信に失敗しました");
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ display: "grid", gap: "1.5rem" }}>
      <section>
        <h3 style={s.h}>現在の設定</h3>
        <div style={s.list}>
          <div style={s.row}>
            <span style={s.label}>🎯 目標</span>
            <span style={{ flex: 1, fontWeight: 600 }}>{goalText}</span>
          </div>
          <div style={s.row}>
            <span style={s.label}>🔥 朝の投稿</span>
            <span style={{ flex: 1 }}>{morningTime} (JST)</span>
          </div>
          <div style={s.row}>
            <span style={s.label}>🌙 夜の投稿</span>
            <span style={{ flex: 1 }}>{nightTime} (JST)</span>
          </div>
          <div style={s.row}>
            <span style={s.label}>📆 頻度</span>
            <span style={{ flex: 1 }}>{frequencyLabel}</span>
          </div>
        </div>
        {!configured && (
          <div style={s.warn}>
            ワークスペース / チャンネルが未設定です。「設定」タブで保存してください。
          </div>
        )}
      </section>

      <section>
        <h3 style={s.h}>今すぐ送信 (テスト)</h3>
        <p style={s.helper}>
          時間窓を無視して、現在の文面をそのままチャンネルへ投稿します。
        </p>
        <div style={s.btnRow}>
          <button
            className="btn btn-primary btn-sm"
            disabled={busy !== null}
            onClick={() => void send("morning")}
          >
            {busy === "morning" ? "送信中..." : "🔥 朝のメッセージを今すぐ送信"}
          </button>
          <button
            className="btn btn-primary btn-sm"
            disabled={busy !== null}
            onClick={() => void send("night")}
          >
            {busy === "night" ? "送信中..." : "🌙 夜のメッセージを今すぐ送信"}
          </button>
        </div>
      </section>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  h: { margin: "0 0 0.5rem", fontSize: "1rem" },
  list: { display: "grid", gap: "0.5rem" },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    padding: "0.5rem 0.75rem",
    border: `1px solid ${colors.border}`,
    borderRadius: "0.375rem",
    background: colors.background,
    fontSize: "0.875rem",
  },
  label: { minWidth: "6rem", color: colors.textSecondary, fontSize: "0.8rem" },
  helper: { margin: "0 0 0.5rem", fontSize: "0.75rem", color: colors.textSecondary },
  btnRow: { display: "flex", gap: "0.75rem", flexWrap: "wrap" },
  warn: {
    marginTop: "0.5rem",
    padding: "0.5rem 0.75rem",
    color: colors.warning,
    background: colors.warningSubtle,
    borderRadius: "0.25rem",
    fontSize: "0.8rem",
  },
};
