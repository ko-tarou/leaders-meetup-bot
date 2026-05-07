import { useEffect, useState, type ReactNode } from "react";
import type { EventAction, Workspace } from "../types";
import { api } from "../api";
import { ChannelSelector } from "./ChannelSelector";
import { colors } from "../styles/tokens";

// ADR-0008 / Sprint 11 PR2:
// member_welcome アクション専用の設定フォーム。
// event_actions.config に保存される JSON のスキーマは以下:
//   {
//     workspaceId?: string;
//     triggerChannelId?: string;
//     inviteChannelIds?: string[];
//     welcomeMessageTemplate?: string;
//   }
type MemberWelcomeConfig = {
  triggerChannelId?: string;
  workspaceId?: string;
  inviteChannelIds?: string[];
  welcomeMessageTemplate?: string;
};

type Props = {
  eventId: string;
  action: EventAction;
  onClose: () => void;
  onSaved: () => void;
};

export function MemberWelcomeConfigForm({
  eventId,
  action,
  onClose,
  onSaved,
}: Props) {
  const initial: MemberWelcomeConfig = (() => {
    try {
      return JSON.parse(action.config || "{}");
    } catch {
      return {};
    }
  })();

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string>(
    initial.workspaceId ?? "",
  );
  const [triggerChannelId, setTriggerChannelId] = useState<string>(
    initial.triggerChannelId ?? "",
  );
  const [inviteChannelsText, setInviteChannelsText] = useState<string>(
    (initial.inviteChannelIds || []).join(", "),
  );
  const [welcomeMessage, setWelcomeMessage] = useState<string>(
    initial.welcomeMessageTemplate ?? "",
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.workspaces
      .list()
      .then((list) => {
        const safe = Array.isArray(list) ? list : [];
        setWorkspaces(safe);
        // 既存 config に workspaceId 未設定で、workspace が1つ以上あれば
        // 先頭をデフォルトに設定する（UX的に空セレクトを避ける）
        if (!workspaceId && safe.length > 0) {
          setWorkspaceId(safe[0].id);
        }
      })
      .catch(() => setWorkspaces([]));
    // 初回マウントのみ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSave = async () => {
    setError(null);
    if (!triggerChannelId) {
      setError("トリガーチャンネルを選択してください");
      return;
    }
    setSubmitting(true);

    const inviteChannelIds = inviteChannelsText
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const config: MemberWelcomeConfig = {
      workspaceId: workspaceId || undefined,
      triggerChannelId,
      inviteChannelIds,
      welcomeMessageTemplate: welcomeMessage.trim() || undefined,
    };

    try {
      await api.events.actions.update(eventId, action.id, {
        config: JSON.stringify(config),
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存に失敗しました");
      setSubmitting(false);
    }
  };

  return (
    <div>
      <p style={{ color: colors.textSecondary, fontSize: "0.875rem", marginTop: 0 }}>
        新メンバーがトリガーチャンネルに参加すると、bot が自動で他のチャンネルに招待し、
        案内メッセージを DM 送信します。
      </p>

      {error && (
        <div
          style={{
            color: colors.danger,
            marginBottom: "0.5rem",
            fontSize: "0.875rem",
          }}
        >
          {error}
        </div>
      )}

      <Field label="ワークスペース">
        <select
          value={workspaceId}
          onChange={(e) => {
            setWorkspaceId(e.target.value);
            // workspace 切替時は triggerChannel をリセット（取得元 WS が変わるため）
            setTriggerChannelId("");
          }}
          style={{
            width: "100%",
            padding: "0.5rem",
            border: `1px solid ${colors.borderStrong}`,
            borderRadius: "0.25rem",
          }}
        >
          {workspaces.length === 0 && <option value="">（未登録）</option>}
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="トリガーチャンネル（新メンバーがここに入ったら発動）">
        <ChannelSelector
          value={triggerChannelId}
          onChange={(id) => setTriggerChannelId(id)}
          workspaceId={workspaceId || undefined}
        />
      </Field>

      <Field label="招待先チャンネル（カンマ区切りで Channel ID を複数指定）">
        <input
          type="text"
          value={inviteChannelsText}
          onChange={(e) => setInviteChannelsText(e.target.value)}
          placeholder="C0XXXXX, C0YYYYY, ..."
          style={{
            width: "100%",
            padding: "0.5rem",
            border: `1px solid ${colors.borderStrong}`,
            borderRadius: "0.25rem",
            boxSizing: "border-box",
          }}
        />
        <small style={{ color: colors.textSecondary, display: "block", marginTop: 4 }}>
          ※ Channel ID は Slack のチャンネル詳細から取得できます
        </small>
      </Field>

      <Field label="案内メッセージ（任意、空ならデフォルト文言）">
        <textarea
          value={welcomeMessage}
          onChange={(e) => setWelcomeMessage(e.target.value)}
          rows={6}
          style={{
            width: "100%",
            padding: "0.5rem",
            border: `1px solid ${colors.borderStrong}`,
            borderRadius: "0.25rem",
            boxSizing: "border-box",
            fontFamily: "inherit",
            fontSize: "0.875rem",
          }}
          placeholder="ようこそ！自己紹介をお願いします。命名ルール: ..."
        />
      </Field>

      <div
        style={{
          display: "flex",
          gap: "0.5rem",
          justifyContent: "flex-end",
          marginTop: "1rem",
        }}
      >
        <button
          onClick={onClose}
          disabled={submitting}
          style={{
            padding: "0.5rem 1rem",
            border: `1px solid ${colors.borderStrong}`,
            background: colors.background,
            borderRadius: "0.25rem",
            cursor: submitting ? "wait" : "pointer",
          }}
        >
          キャンセル
        </button>
        <button
          onClick={handleSave}
          disabled={submitting}
          style={{
            background: colors.primary,
            color: colors.textInverse,
            border: "none",
            padding: "0.5rem 1rem",
            borderRadius: "0.25rem",
            cursor: submitting ? "wait" : "pointer",
          }}
        >
          {submitting ? "保存中..." : "保存"}
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: "0.75rem" }}>
      <label
        style={{
          display: "block",
          marginBottom: "0.25rem",
          fontSize: "0.875rem",
          color: colors.text,
        }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}
