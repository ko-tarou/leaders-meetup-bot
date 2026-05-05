import { useState, type CSSProperties, type ReactNode } from "react";
import type { EventAction } from "../types";
import { api } from "../api";
import { ChannelSelector } from "./ChannelSelector";

// Sprint 23 PR2: attendance_check アクション専用の設定フォーム + メイン表示。
//
// 設定 (event_actions.config) のスキーマ:
//   {
//     channelId: "C_HACKIT_OPS",
//     schedule: {
//       dayOfWeek: 0..6,
//       polls: [
//         { key: "morning", name: "朝会出席確認",
//           postTime: "09:00", closeTime: "10:00",
//           title: "今日の朝会(9:00-10:00)に出席しますか？" }
//       ]
//     }
//   }

type AttendancePoll = {
  key: string;
  name: string;
  postTime: string;
  closeTime: string;
  title: string;
};

type AttendanceConfig = {
  channelId?: string;
  schedule?: {
    dayOfWeek?: number;
    polls?: AttendancePoll[];
  };
};

const DAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];
const KEY_RE = /^[a-z0-9]+$/;
const HM_RE = /^\d{2}:\d{2}$/;

function parseConfig(raw: string): AttendanceConfig {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function defaultPoll(): AttendancePoll {
  return {
    key: "morning",
    name: "朝会出席確認",
    postTime: "09:00",
    closeTime: "10:00",
    title: "今日の定例(9:00-10:00)に出席しますか？",
  };
}

// メイン表示: 次回の post 予定をサマリ
export function AttendanceCheckMain({ action }: { action: EventAction }) {
  const cfg = parseConfig(action.config);
  const dow = cfg.schedule?.dayOfWeek;
  const polls = cfg.schedule?.polls ?? [];
  const channelId = cfg.channelId;

  if (dow == null || polls.length === 0 || !channelId) {
    return (
      <div style={{ padding: "1.5rem", color: "#6b7280" }}>
        曜日・チャンネル・投票が未設定です。「設定」タブから登録してください。
      </div>
    );
  }

  return (
    <div style={{ padding: "0.5rem 0" }}>
      <div style={mainCard}>
        <div style={{ fontSize: "0.875rem", color: "#6b7280" }}>
          毎週の投稿予定（チャンネル {channelId}）
        </div>
        <div
          style={{ fontSize: "1.1rem", fontWeight: 600, marginTop: "0.25rem" }}
        >
          {DAY_LABELS[dow] ?? "?"}曜日
        </div>
        <ul style={{ margin: "0.5rem 0 0 1rem", padding: 0 }}>
          {polls.map((p) => (
            <li
              key={p.key}
              style={{ fontSize: "0.875rem", color: "#374151" }}
            >
              <strong>{p.name || p.key}</strong>: {p.postTime} 投稿 →{" "}
              {p.closeTime} 締切
            </li>
          ))}
        </ul>
      </div>
      <p style={{ fontSize: "0.875rem", color: "#6b7280" }}>
        個別の回答は ephemeral 応答で本人にのみ表示されます。チャンネルには集計
        (出席 N / 欠席 N / 未定 N) のみ post されます。
      </p>
    </div>
  );
}

// 設定タブ: チャンネル + 曜日 + polls 配列の編集 UI
export function AttendanceCheckForm({
  eventId,
  action,
  workspaceId,
  onSaved,
}: {
  eventId: string;
  action: EventAction;
  workspaceId?: string;
  onSaved: () => void;
}) {
  const initial = parseConfig(action.config);
  const [channelId, setChannelId] = useState(initial.channelId ?? "");
  const [dayOfWeek, setDayOfWeek] = useState<number>(
    typeof initial.schedule?.dayOfWeek === "number"
      ? initial.schedule.dayOfWeek
      : 1,
  );
  const [polls, setPolls] = useState<AttendancePoll[]>(
    initial.schedule?.polls && initial.schedule.polls.length > 0
      ? initial.schedule.polls
      : [defaultPoll()],
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updatePoll = (idx: number, patch: Partial<AttendancePoll>) => {
    setPolls((prev) =>
      prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)),
    );
  };
  const addPoll = () => {
    setPolls((prev) => [
      ...prev,
      {
        key: `poll${prev.length + 1}`,
        name: "",
        postTime: "20:00",
        closeTime: "21:00",
        title: "",
      },
    ]);
  };
  const removePoll = (idx: number) => {
    setPolls((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSave = async () => {
    setError(null);
    if (!channelId.trim()) {
      setError("チャンネル ID は必須です");
      return;
    }
    if (polls.length === 0) {
      setError("少なくとも 1 つ投票を登録してください");
      return;
    }
    const seenKeys = new Set<string>();
    for (const p of polls) {
      if (!KEY_RE.test(p.key)) {
        setError(`key は英小文字+数字のみ: "${p.key}"`);
        return;
      }
      if (seenKeys.has(p.key)) {
        setError(`key が重複しています: "${p.key}"`);
        return;
      }
      seenKeys.add(p.key);
      if (!HM_RE.test(p.postTime) || !HM_RE.test(p.closeTime)) {
        setError(`時刻は HH:MM 形式: "${p.postTime}" / "${p.closeTime}"`);
        return;
      }
      if (!p.title.trim()) {
        setError(`title は必須: key="${p.key}"`);
        return;
      }
    }

    setSubmitting(true);
    const cfg: AttendanceConfig = {
      channelId: channelId.trim(),
      schedule: {
        dayOfWeek,
        polls: polls.map((p) => ({
          key: p.key.trim(),
          name: p.name.trim(),
          postTime: p.postTime,
          closeTime: p.closeTime,
          title: p.title.trim(),
        })),
      },
    };

    try {
      await api.events.actions.update(eventId, action.id, {
        config: JSON.stringify(cfg),
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <p style={{ color: "#6b7280", fontSize: "0.875rem", marginTop: 0 }}>
        指定曜日の各時刻にチャンネルへ匿名投票を post します。
        個別の回答は ephemeral 応答で本人だけが見られ、チャンネルには集計のみ
        post されます。実際の post は 5 分 cron で動くため、指定時刻から数分以内のずれが発生します。
      </p>

      {error && (
        <div
          style={{
            color: "#dc2626",
            marginBottom: "0.5rem",
            fontSize: "0.875rem",
          }}
        >
          {error}
        </div>
      )}

      <Field label="投稿チャンネル">
        <ChannelSelector
          value={channelId}
          onChange={(id) => setChannelId(id)}
          workspaceId={workspaceId}
        />
      </Field>

      <Field label="曜日">
        <select
          value={dayOfWeek}
          onChange={(e) => setDayOfWeek(Number(e.target.value))}
          disabled={submitting}
          style={styles.select}
        >
          {DAY_LABELS.map((label, i) => (
            <option key={i} value={i}>
              {label}曜日
            </option>
          ))}
        </select>
      </Field>

      <Field label="投票一覧">
        <div style={{ display: "grid", gap: "0.75rem" }}>
          {polls.map((p, idx) => (
            <div key={idx} style={pollCard}>
              <div style={{ display: "flex", alignItems: "center" }}>
                <strong style={{ fontSize: "0.9rem" }}>
                  投票 #{idx + 1}
                </strong>
                <button
                  type="button"
                  onClick={() => removePoll(idx)}
                  disabled={submitting || polls.length <= 1}
                  style={{ ...styles.removeBtn, marginLeft: "auto" }}
                >
                  削除
                </button>
              </div>
              <div style={pollRow}>
                <Field label="key (英小文字+数字)">
                  <input
                    value={p.key}
                    onChange={(e) => updatePoll(idx, { key: e.target.value })}
                    disabled={submitting}
                    placeholder="morning"
                    style={styles.input}
                  />
                </Field>
                <Field label="表示名 (任意)">
                  <input
                    value={p.name}
                    onChange={(e) =>
                      updatePoll(idx, { name: e.target.value })
                    }
                    disabled={submitting}
                    placeholder="朝会出席確認"
                    style={styles.input}
                  />
                </Field>
              </div>
              <div style={pollRow}>
                <Field label="投稿時刻 (JST)">
                  <input
                    type="time"
                    value={p.postTime}
                    onChange={(e) =>
                      updatePoll(idx, { postTime: e.target.value })
                    }
                    disabled={submitting}
                    style={styles.input}
                  />
                </Field>
                <Field label="締切時刻 (JST)">
                  <input
                    type="time"
                    value={p.closeTime}
                    onChange={(e) =>
                      updatePoll(idx, { closeTime: e.target.value })
                    }
                    disabled={submitting}
                    style={styles.input}
                  />
                </Field>
              </div>
              <Field label="タイトル (Slack 投稿の見出し)">
                <input
                  value={p.title}
                  onChange={(e) => updatePoll(idx, { title: e.target.value })}
                  disabled={submitting}
                  placeholder="今日の朝会(9:00-10:00)に出席しますか？"
                  style={styles.input}
                />
              </Field>
            </div>
          ))}
          <button
            type="button"
            onClick={addPoll}
            disabled={submitting}
            style={styles.addPollBtn}
          >
            + 投票を追加
          </button>
        </div>
      </Field>

      <div style={styles.formActions}>
        <button
          type="button"
          onClick={handleSave}
          disabled={submitting}
          style={styles.primaryBtn}
        >
          {submitting ? "保存中..." : "保存"}
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: "0.75rem", flex: 1 }}>
      <label style={styles.fieldLabel}>{label}</label>
      {children}
    </div>
  );
}

const mainCard: CSSProperties = {
  padding: "1rem",
  border: "1px solid #e5e7eb",
  borderRadius: "0.5rem",
  background: "#f9fafb",
  marginBottom: "1rem",
};

const pollCard: CSSProperties = {
  padding: "0.75rem",
  border: "1px solid #e5e7eb",
  borderRadius: "0.5rem",
  background: "#fff",
};

const pollRow: CSSProperties = {
  display: "flex",
  gap: "0.5rem",
};

const styles: Record<string, CSSProperties> = {
  fieldLabel: {
    display: "block",
    marginBottom: "0.25rem",
    fontSize: "0.875rem",
    color: "#374151",
  },
  select: {
    width: "100%",
    padding: "0.5rem",
    border: "1px solid #d1d5db",
    borderRadius: "0.25rem",
    boxSizing: "border-box",
  },
  input: {
    width: "100%",
    padding: "0.5rem",
    border: "1px solid #d1d5db",
    borderRadius: "0.25rem",
    boxSizing: "border-box",
  },
  removeBtn: {
    background: "#fff",
    color: "#dc2626",
    border: "1px solid #dc2626",
    padding: "0.25rem 0.5rem",
    borderRadius: "0.25rem",
    cursor: "pointer",
    fontSize: "0.75rem",
  },
  addPollBtn: {
    background: "#fff",
    color: "#2563eb",
    border: "1px dashed #2563eb",
    padding: "0.5rem",
    borderRadius: "0.25rem",
    cursor: "pointer",
    fontSize: "0.875rem",
  },
  formActions: {
    display: "flex",
    gap: "0.5rem",
    marginTop: "1rem",
    justifyContent: "flex-end",
  },
  primaryBtn: {
    background: "#2563eb",
    color: "white",
    border: "none",
    padding: "0.5rem 1rem",
    borderRadius: "0.25rem",
    cursor: "pointer",
  },
};
