import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { api, APIError } from "../../api";
import type { EventAction, SlackUser, Workspace } from "../../types";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toast";
import { useIsReadOnly } from "../../hooks/usePublicMode";
import { SingleChannelPicker } from "../ui/SingleChannelPicker";
import { colors } from "../../styles/tokens";

// member_application: 応募時の Slack 通知タブ。
//
// action.config.notifications に
//   { enabled, workspaceId, channelId, channelName, mentionUserIds,
//     messageTemplate }
// を保存する。応募作成 (POST /apply/:eventId) 成功時に BE から指定チャンネルへ
// メッセージを post する。通知失敗は応募 API を失敗させない (fail-soft)。
//
// UI 構成 (リファクタ後):
//   1. 「☑ 有効化」: toggle 即保存
//   2. チャンネル / メンション / 通知文は Display モード
//      + 「編集」ボタンでセクションごとに展開する Edit モード
//
// channelName は既存データでは無い場合があるため、表示時は `channelName || channelId`
// にフォールバックする。メンション名前は workspace members から resolve する。

type NotificationsConfig = {
  enabled: boolean;
  workspaceId: string;
  channelId: string;
  channelName: string;
  mentionUserIds: string[];
  // 通知文テンプレ。空文字 / 未設定なら BE 側で DEFAULT_TEMPLATE を使う。
  messageTemplate: string;
};

// 編集対象モード。
//   application  → action.config.notifications (応募通知)
//   participation → action.config.participationNotifications (参加届通知)
//   participationUnresolved → action.config.participationUnresolvedNotifications
//                             (参加届の Slack 表示名解決失敗 = 未解決通知)
type NotificationMode =
  | "application"
  | "participation"
  | "participationUnresolved";

type ModeDef = {
  // 編集対象となる action.config 内のキー。
  configKey:
    | "notifications"
    | "participationNotifications"
    | "participationUnresolvedNotifications";
  // セグメントに表示するラベル。
  label: string;
  // ヘッダ説明文 (fail-soft の文言含む)。
  description: string;
  // 空文字 / 未設定保存時に BE が使うデフォルト文面 (BE と同期)。
  defaultTemplate: string;
  // プレビュー用サンプルデータ (BE の placeholder 仕様と一対一対応)。
  sampleVars: Record<string, string>;
  // 表示用 placeholder 一覧 (キー + 説明)。
  placeholders: { key: string; desc: string }[];
};

// BE: src/services/application-notification.ts:DEFAULT_TEMPLATE と同期。
const APPLICATION_DEFAULT_TEMPLATE = `{mentions} 新しい応募がありました
名前: {name}
メール: {email}
応募日時: {appliedAt} (JST)`;

// BE: src/services/participation-notification.ts:DEFAULT_PARTICIPATION_TEMPLATE と同期。
const PARTICIPATION_DEFAULT_TEMPLATE = `{mentions} 📋 参加届が提出されました
名前: {name}
Slack表示名: {slackName}
メール: {email}
希望活動: {desiredActivity}`;

// BE: src/services/participation-notification.ts:DEFAULT_PARTICIPATION_UNRESOLVED_TEMPLATE と同期。
const PARTICIPATION_UNRESOLVED_DEFAULT_TEMPLATE = `{mentions} ⚠️ 参加届の Slack 表示名が見つかりませんでした
名前: {name}
Slack表示名: {slackName}
メール: {email}
希望活動: {desiredActivity}
手動でのロール紐付けが必要です（参加届タブ）`;

// モードごとの定義テーブル (DRY: 同一エディタを configKey で切替)。
const MODE_DEFS: Record<NotificationMode, ModeDef> = {
  application: {
    configKey: "notifications",
    label: "応募通知",
    description:
      "新規応募があった時に Slack 通知を送ります。通知失敗で応募自体が失敗することはありません (fail-soft)。",
    defaultTemplate: APPLICATION_DEFAULT_TEMPLATE,
    sampleVars: {
      mentions: "<@U1>",
      name: "鈴木 太郎",
      email: "suzuki@example.com",
      appliedAt: "2026/05/11 14:30",
      studentId: "1EP1-1",
      howFound: "joint_briefing",
      interviewLocation: "online",
      interviewAt: "2026/05/15 10:00",
    },
    placeholders: [
      { key: "mentions", desc: "メンション (<@U1> <@U2> ...)" },
      { key: "name", desc: "応募者名" },
      { key: "email", desc: "メール" },
      { key: "appliedAt", desc: "応募日時 (JST)" },
      { key: "studentId", desc: "学生証番号" },
      { key: "howFound", desc: "どこで知ったか" },
      { key: "interviewLocation", desc: "面接場所" },
      { key: "interviewAt", desc: "希望面接日時 (JST)" },
    ],
  },
  participation: {
    configKey: "participationNotifications",
    label: "参加届通知",
    description:
      "参加届が提出された時に Slack 通知を送ります。通知失敗で参加届提出自体が失敗することはありません (fail-soft)。",
    defaultTemplate: PARTICIPATION_DEFAULT_TEMPLATE,
    sampleVars: {
      mentions: "<@U1>",
      name: "鈴木 太郎",
      slackName: "suzuki",
      email: "suzuki@example.com",
      studentId: "1EP1-1",
      department: "情報工学科",
      grade: "3",
      gender: "male",
      desiredActivity: "dev",
      devRoles: "frontend, backend",
      otherAffiliations: "なし",
      submittedAt: "2026/05/11 14:30",
    },
    placeholders: [
      { key: "mentions", desc: "メンション (<@U1> <@U2> ...)" },
      { key: "name", desc: "氏名" },
      { key: "slackName", desc: "Slack 表示名" },
      { key: "email", desc: "メール" },
      { key: "studentId", desc: "学生証番号" },
      { key: "department", desc: "学科" },
      { key: "grade", desc: "学年" },
      { key: "gender", desc: "性別" },
      { key: "desiredActivity", desc: "希望活動" },
      { key: "devRoles", desc: "開発ロール (カンマ区切り)" },
      { key: "otherAffiliations", desc: "他の所属" },
      { key: "submittedAt", desc: "提出日時 (JST)" },
    ],
  },
  participationUnresolved: {
    configKey: "participationUnresolvedNotifications",
    label: "参加届(未解決)通知",
    description:
      "参加届の Slack 表示名解決に失敗した時に Slack 通知を送ります。通知失敗で参加届提出自体が失敗することはありません (fail-soft)。",
    defaultTemplate: PARTICIPATION_UNRESOLVED_DEFAULT_TEMPLATE,
    sampleVars: {
      mentions: "<@U1>",
      name: "鈴木 太郎",
      slackName: "suzuki",
      email: "suzuki@example.com",
      studentId: "1EP1-1",
      department: "情報工学科",
      grade: "3",
      gender: "male",
      desiredActivity: "dev",
      devRoles: "frontend, backend",
      otherAffiliations: "なし",
      submittedAt: "2026/05/11 14:30",
    },
    placeholders: [
      { key: "mentions", desc: "メンション (<@U1> <@U2> ...)" },
      { key: "name", desc: "氏名" },
      { key: "slackName", desc: "Slack 表示名" },
      { key: "email", desc: "メール" },
      { key: "studentId", desc: "学生証番号" },
      { key: "department", desc: "学科" },
      { key: "grade", desc: "学年" },
      { key: "gender", desc: "性別" },
      { key: "desiredActivity", desc: "希望活動" },
      { key: "devRoles", desc: "開発ロール (カンマ区切り)" },
      { key: "otherAffiliations", desc: "他の所属" },
      { key: "submittedAt", desc: "提出日時 (JST)" },
    ],
  },
};

/**
 * `{key}` を vars[key] で置換。未定義 key は元の `{key}` を残す。
 * BE: src/services/application-notification.ts:renderTemplate と同等。
 */
function renderTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (m, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : m,
  );
}

type Props = {
  eventId: string;
  action: EventAction;
  onSaved?: () => void;
};

function readInitialConfig(
  action: EventAction,
  configKey: ModeDef["configKey"],
): NotificationsConfig {
  try {
    const parsed = JSON.parse(action.config || "{}") as Record<
      string,
      Partial<NotificationsConfig> | undefined
    >;
    const n = parsed[configKey] ?? {};
    return {
      enabled: Boolean(n.enabled),
      workspaceId: typeof n.workspaceId === "string" ? n.workspaceId : "",
      channelId: typeof n.channelId === "string" ? n.channelId : "",
      channelName: typeof n.channelName === "string" ? n.channelName : "",
      mentionUserIds: Array.isArray(n.mentionUserIds)
        ? (n.mentionUserIds.filter((u) => typeof u === "string") as string[])
        : [],
      messageTemplate:
        typeof n.messageTemplate === "string" ? n.messageTemplate : "",
    };
  } catch {
    return {
      enabled: false,
      workspaceId: "",
      channelId: "",
      channelName: "",
      mentionUserIds: [],
      messageTemplate: "",
    };
  }
}

export function NotificationsTab({ eventId, action, onSaved }: Props) {
  const toast = useToast();
  const isReadOnly = useIsReadOnly();

  // 編集対象モード (上部セグメントで切替)。
  const [mode, setMode] = useState<NotificationMode>("application");
  const modeDef = MODE_DEFS[mode];

  const initial = useMemo(
    () => readInitialConfig(action, modeDef.configKey),
    [action, modeDef.configKey],
  );

  // 確定値 (= 保存済みの notifications config)
  const [enabled, setEnabled] = useState<boolean>(initial.enabled);
  const [workspaceId, setWorkspaceId] = useState<string>(initial.workspaceId);
  const [channelId, setChannelId] = useState<string>(initial.channelId);
  const [channelName, setChannelName] = useState<string>(initial.channelName);
  const [mentionUserIds, setMentionUserIds] = useState<string[]>(
    initial.mentionUserIds,
  );
  const [messageTemplate, setMessageTemplate] = useState<string>(
    initial.messageTemplate,
  );

  // 編集モードフラグ (セクション独立)
  const [editingChannel, setEditingChannel] = useState<boolean>(false);
  const [editingMentions, setEditingMentions] = useState<boolean>(false);
  const [editingTemplate, setEditingTemplate] = useState<boolean>(false);

  // チャンネル編集 draft
  const [draftWorkspaceId, setDraftWorkspaceId] = useState<string>(workspaceId);
  const [draftChannelId, setDraftChannelId] = useState<string>(channelId);
  const [draftChannelName, setDraftChannelName] = useState<string>(channelName);

  // メンション編集 draft
  const [draftMentionUserIds, setDraftMentionUserIds] =
    useState<string[]>(mentionUserIds);

  // 通知文編集 draft (空文字 = デフォルト扱い)
  const [draftMessageTemplate, setDraftMessageTemplate] =
    useState<string>(messageTemplate);

  // 共通: workspace / members fetch (display と edit 両方で使う)
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [members, setMembers] = useState<SlackUser[] | null>(null);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [memberSearch, setMemberSearch] = useState<string>("");

  // 編集中に表示する members の workspace は draftWorkspaceId に追従させる。
  // 編集していないときは確定値 workspaceId を使う (mention 名前 resolve 用)。
  const activeWorkspaceId = editingChannel ? draftWorkspaceId : workspaceId;

  const [saving, setSaving] = useState<boolean>(false);

  // mode 切替時: 確定 state を切替先 mode の保存値で再初期化する。
  // 未保存ドラフトは破棄でよい (確認ダイアログ不要) ため編集モードも閉じる。
  // 依存は initial (= action / configKey に応じて useMemo で安定) のみなので
  // mode 連打や再 render での無限ループは発生しない。
  useEffect(() => {
    setEnabled(initial.enabled);
    setWorkspaceId(initial.workspaceId);
    setChannelId(initial.channelId);
    setChannelName(initial.channelName);
    setMentionUserIds(initial.mentionUserIds);
    setMessageTemplate(initial.messageTemplate);
    setEditingChannel(false);
    setEditingMentions(false);
    setEditingTemplate(false);
  }, [initial]);

  // workspaces 一覧取得
  useEffect(() => {
    let cancelled = false;
    api.workspaces
      .list()
      .then((list) => {
        if (cancelled) return;
        setWorkspaces(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (cancelled) return;
        setWorkspaces([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // channelName fallback: 既存設定で channelId はあるが channelName が無いケース
  // (PR #160 以前に保存された config) は Slack API から name を resolve する。
  // 失敗は無視 (display は channelId にフォールバック)。
  useEffect(() => {
    if (!channelId) return;
    if (channelName) return;
    let cancelled = false;
    api
      .getChannelName(channelId)
      .then((res) => {
        if (cancelled) return;
        if (res?.name) setChannelName(res.name);
      })
      .catch(() => {
        // ignore: display falls back to channelId
      });
    return () => {
      cancelled = true;
    };
  }, [channelId, channelName]);

  // active workspace のメンバー一覧
  useEffect(() => {
    if (!activeWorkspaceId) {
      setMembers(null);
      setMembersError(null);
      return;
    }
    let cancelled = false;
    setMembers(null);
    setMembersError(null);
    api.workspaces
      .members(activeWorkspaceId)
      .then((list) => {
        if (cancelled) return;
        setMembers(Array.isArray(list) ? list : []);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setMembers([]);
        if (e instanceof APIError) {
          setMembersError(`メンバー取得に失敗しました (${e.status})`);
        } else {
          setMembersError("メンバー取得に失敗しました");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId]);

  // id → 表示名 map
  const memberMap = useMemo(() => {
    const m = new Map<string, string>();
    (members ?? []).forEach((u) => {
      m.set(u.id, u.displayName || u.realName || u.name);
    });
    return m;
  }, [members]);

  // workspace 名解決 (display 補助)
  const workspaceName = useMemo(() => {
    if (!workspaceId) return "";
    const w = (workspaces ?? []).find((x) => x.id === workspaceId);
    return w?.name ?? workspaceId;
  }, [workspaces, workspaceId]);

  const filteredMembers = useMemo(() => {
    if (!members) return [];
    const q = memberSearch.trim().toLowerCase();
    if (!q) return members;
    return members.filter(
      (u) =>
        u.name.toLowerCase().includes(q) ||
        (u.realName?.toLowerCase().includes(q) ?? false) ||
        (u.displayName?.toLowerCase().includes(q) ?? false) ||
        u.id.toLowerCase().includes(q),
    );
  }, [members, memberSearch]);

  // 保存ヘルパー: notifications の一部を patch して PUT する。
  // 成功時はローカル state を確定値に反映し、merged config を返す。
  const saveNotifications = async (
    patch: Partial<NotificationsConfig>,
  ): Promise<NotificationsConfig | null> => {
    if (isReadOnly) return null;
    let baseConfig: Record<string, unknown> = {};
    try {
      baseConfig = JSON.parse(action.config || "{}");
    } catch {
      baseConfig = {};
    }
    const current: NotificationsConfig = {
      enabled,
      workspaceId,
      channelId,
      channelName,
      mentionUserIds,
      messageTemplate,
    };
    const merged: NotificationsConfig = { ...current, ...patch };
    // baseConfig を spread して対象 configKey のみ上書き。
    // もう一方の通知キー / slackInvites 等 他キーは温存される。
    const newConfig = { ...baseConfig, [modeDef.configKey]: merged };
    setSaving(true);
    try {
      await api.events.actions.update(eventId, action.id, {
        config: JSON.stringify(newConfig),
      });
      setEnabled(merged.enabled);
      setWorkspaceId(merged.workspaceId);
      setChannelId(merged.channelId);
      setChannelName(merged.channelName);
      setMentionUserIds(merged.mentionUserIds);
      setMessageTemplate(merged.messageTemplate);
      onSaved?.();
      return merged;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存に失敗しました");
      return null;
    } finally {
      setSaving(false);
    }
  };

  // 有効化 toggle 即保存
  const handleToggleEnabled = async (next: boolean) => {
    const result = await saveNotifications({ enabled: next });
    if (result) {
      toast.success(next ? "通知を有効化しました" : "通知を無効化しました");
    }
  };

  // チャンネル編集
  const startEditChannel = () => {
    setDraftWorkspaceId(workspaceId);
    setDraftChannelId(channelId);
    setDraftChannelName(channelName);
    setEditingChannel(true);
  };

  const saveChannel = async () => {
    if (!draftWorkspaceId) {
      toast.error("ワークスペースを選択してください");
      return;
    }
    if (!draftChannelId) {
      toast.error("通知先チャンネルを選択してください");
      return;
    }
    const result = await saveNotifications({
      workspaceId: draftWorkspaceId,
      channelId: draftChannelId,
      channelName: draftChannelName,
    });
    if (result) {
      toast.success("チャンネルを保存しました");
      setEditingChannel(false);
    }
  };

  // メンション編集
  const startEditMentions = () => {
    setDraftMentionUserIds(mentionUserIds);
    setMemberSearch("");
    setEditingMentions(true);
  };

  const toggleDraftMention = (id: string) => {
    setDraftMentionUserIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const saveMentions = async () => {
    const result = await saveNotifications({
      mentionUserIds: draftMentionUserIds,
    });
    if (result) {
      toast.success("メンション設定を保存しました");
      setEditingMentions(false);
    }
  };

  // 通知文編集
  const startEditTemplate = () => {
    // 現在保存値が空ならテキストエリアに DEFAULT_TEMPLATE を出して編集しやすく。
    setDraftMessageTemplate(messageTemplate || modeDef.defaultTemplate);
    setEditingTemplate(true);
  };

  const saveTemplate = async () => {
    // trim 後が DEFAULT_TEMPLATE と完全一致 or 空なら、空文字を保存して
    // 「デフォルト扱い」に戻す (BE 側は空文字 → DEFAULT_TEMPLATE)。
    const trimmed = draftMessageTemplate.trim();
    const next =
      trimmed === "" || trimmed === modeDef.defaultTemplate.trim()
        ? ""
        : draftMessageTemplate;
    const result = await saveNotifications({ messageTemplate: next });
    if (result) {
      toast.success("通知文を保存しました");
      setEditingTemplate(false);
    }
  };

  const resetTemplateToDefault = () => {
    setDraftMessageTemplate(modeDef.defaultTemplate);
  };

  // 通知文 display 用 (空ならデフォルトを表示)。
  const displayTemplate = messageTemplate || modeDef.defaultTemplate;
  const isDefaultTemplate = !messageTemplate;

  // 編集中のリアルタイムプレビュー (textarea 下に常時表示)。
  // {mentions} を空にすると先頭にスペース余りが出るため、render 結果は trim する。
  const previewText = useMemo(
    () => renderTemplate(draftMessageTemplate, modeDef.sampleVars).trim(),
    [draftMessageTemplate, modeDef.sampleVars],
  );

  // メンション display 用名前
  const mentionNames = useMemo(
    () => mentionUserIds.map((id) => memberMap.get(id) ?? `<@${id}>`),
    [mentionUserIds, memberMap],
  );

  return (
    <div>
      <div style={styles.section}>
        <h3 style={styles.h3}>通知設定</h3>
        <div style={styles.segment} role="tablist">
          {(Object.keys(MODE_DEFS) as NotificationMode[]).map((m) => {
            const active = m === mode;
            return (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setMode(m)}
                disabled={saving}
                style={{
                  ...styles.segmentButton,
                  ...(active ? styles.segmentButtonActive : {}),
                }}
              >
                {MODE_DEFS[m].label}
              </button>
            );
          })}
        </div>
        <p style={styles.desc}>{modeDef.description}</p>
      </div>

      <div style={styles.section}>
        <label style={styles.toggleRow}>
          <input
            type="checkbox"
            checked={enabled}
            disabled={isReadOnly || saving}
            onChange={(e) => void handleToggleEnabled(e.target.checked)}
          />
          <span>通知を有効にする</span>
        </label>
      </div>

      {enabled && (
        <>
          {/* === チャンネル === */}
          <div style={styles.section}>
            {!editingChannel ? (
              <div style={styles.summaryRow}>
                <div style={styles.summaryBody}>
                  <div style={styles.summaryLabel}>チャンネル</div>
                  <div style={styles.summaryValue}>
                    {channelId ? (
                      <code>#{channelName || channelId}</code>
                    ) : (
                      <span style={styles.muted}>未設定</span>
                    )}
                  </div>
                </div>
                <Button
                  variant="secondary"
                  onClick={startEditChannel}
                  disabled={isReadOnly || saving}
                >
                  編集
                </Button>
              </div>
            ) : (
              <div style={styles.editBox}>
                <div style={styles.editTitle}>チャンネル</div>

                <div style={styles.editField}>
                  <label style={styles.label}>ワークスペース</label>
                  {workspaces === null ? (
                    <span style={styles.muted}>取得中...</span>
                  ) : workspaces.length === 0 ? (
                    <span style={styles.muted}>
                      登録済みのワークスペースがありません。
                    </span>
                  ) : (
                    <select
                      value={draftWorkspaceId}
                      disabled={isReadOnly || saving}
                      onChange={(e) => {
                        setDraftWorkspaceId(e.target.value);
                        // workspace を切り替えたら channel もリセット
                        setDraftChannelId("");
                        setDraftChannelName("");
                      }}
                      style={styles.input}
                    >
                      <option value="">選択してください</option>
                      {workspaces.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                {draftWorkspaceId && (
                  <div style={styles.editField}>
                    <label style={styles.label}>通知先チャンネル</label>
                    <SingleChannelPicker
                      value={draftChannelId}
                      channelName={draftChannelName}
                      workspaceId={draftWorkspaceId}
                      onChange={(id, name) => {
                        setDraftChannelId(id);
                        setDraftChannelName(name);
                      }}
                      disabled={isReadOnly || saving}
                    />
                  </div>
                )}

                <div style={styles.editActions}>
                  <Button
                    variant="primary"
                    onClick={() => void saveChannel()}
                    disabled={saving || isReadOnly}
                  >
                    {saving ? "保存中..." : "保存"}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => setEditingChannel(false)}
                    disabled={saving}
                  >
                    キャンセル
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* === メンション === */}
          <div style={styles.section}>
            {!editingMentions ? (
              <div style={styles.summaryRow}>
                <div style={styles.summaryBody}>
                  <div style={styles.summaryLabel}>メンション</div>
                  <div style={styles.summaryValue}>
                    {mentionUserIds.length === 0 ? (
                      <span style={styles.muted}>なし</span>
                    ) : (
                      mentionNames.join(", ")
                    )}
                  </div>
                </div>
                <Button
                  variant="secondary"
                  onClick={startEditMentions}
                  disabled={isReadOnly || saving || !workspaceId}
                  title={
                    !workspaceId
                      ? "先にチャンネル (ワークスペース) を設定してください"
                      : undefined
                  }
                >
                  編集
                </Button>
              </div>
            ) : (
              <div style={styles.editBox}>
                <div style={styles.editTitle}>メンション</div>
                {!workspaceId ? (
                  <div style={styles.warn}>
                    先にチャンネル (ワークスペース) を設定してください。
                  </div>
                ) : membersError ? (
                  <div style={styles.warn}>{membersError}</div>
                ) : members === null ? (
                  <span style={styles.muted}>メンバー取得中...</span>
                ) : members.length === 0 ? (
                  <span style={styles.muted}>
                    ワークスペースのメンバーが取得できません。
                  </span>
                ) : (
                  <>
                    <input
                      value={memberSearch}
                      onChange={(e) => setMemberSearch(e.target.value)}
                      placeholder="名前 / @handle / Slack User ID で検索..."
                      style={{ ...styles.input, marginBottom: "0.5rem" }}
                    />
                    <div style={styles.memberList}>
                      {filteredMembers.length === 0 ? (
                        <div style={styles.muted}>
                          該当するメンバーがいません。
                        </div>
                      ) : (
                        filteredMembers.map((u) => {
                          const checked = draftMentionUserIds.includes(u.id);
                          return (
                            <label key={u.id} style={styles.memberRow}>
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={isReadOnly || saving}
                                onChange={() => toggleDraftMention(u.id)}
                              />
                              <span style={{ fontWeight: 500 }}>
                                {u.displayName || u.realName || u.name}
                              </span>
                              <span style={styles.metaInline}>@{u.name}</span>
                            </label>
                          );
                        })
                      )}
                    </div>
                    <div style={styles.metaSmall}>
                      選択中: {draftMentionUserIds.length} 人
                    </div>
                  </>
                )}

                <div style={styles.editActions}>
                  <Button
                    variant="primary"
                    onClick={() => void saveMentions()}
                    disabled={saving || isReadOnly || !workspaceId}
                  >
                    {saving ? "保存中..." : "保存"}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => setEditingMentions(false)}
                    disabled={saving}
                  >
                    キャンセル
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* === 通知文 === */}
          <div style={styles.section}>
            {!editingTemplate ? (
              <div style={styles.summaryRow}>
                <div style={styles.summaryBody}>
                  <div style={styles.summaryLabel}>
                    通知文{isDefaultTemplate ? " (デフォルト)" : ""}
                  </div>
                  <pre style={styles.templatePreview}>{displayTemplate}</pre>
                </div>
                <Button
                  variant="secondary"
                  onClick={startEditTemplate}
                  disabled={isReadOnly || saving}
                >
                  編集
                </Button>
              </div>
            ) : (
              <div style={styles.editBox}>
                <div style={styles.editTitle}>通知文</div>

                <div style={styles.editField}>
                  <label style={styles.label}>テンプレート</label>
                  <textarea
                    value={draftMessageTemplate}
                    onChange={(e) => setDraftMessageTemplate(e.target.value)}
                    rows={6}
                    disabled={isReadOnly || saving}
                    style={styles.textarea}
                    placeholder={modeDef.defaultTemplate}
                  />
                </div>

                <div style={styles.editField}>
                  <label style={styles.label}>使用可能なプレースホルダー</label>
                  <div style={styles.placeholderList}>
                    {modeDef.placeholders.map((p) => (
                      <div key={p.key} style={styles.placeholderRow}>
                        <code style={styles.placeholderKey}>{`{${p.key}}`}</code>
                        <span style={styles.placeholderDesc}>{p.desc}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div style={styles.editField}>
                  <label style={styles.label}>プレビュー</label>
                  <pre style={styles.templatePreview}>{previewText}</pre>
                </div>

                <div style={styles.editActions}>
                  <Button
                    variant="primary"
                    onClick={() => void saveTemplate()}
                    disabled={saving || isReadOnly}
                  >
                    {saving ? "保存中..." : "保存"}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => setEditingTemplate(false)}
                    disabled={saving}
                  >
                    キャンセル
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={resetTemplateToDefault}
                    disabled={saving || isReadOnly}
                  >
                    デフォルトに戻す
                  </Button>
                </div>
              </div>
            )}
          </div>

          {workspaceId && workspaceName && (
            <div style={styles.metaSmall}>
              ワークスペース: {workspaceName}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  section: {
    marginBottom: "1rem",
  },
  h3: {
    margin: "0 0 0.5rem",
    fontSize: "1rem",
  },
  desc: {
    margin: 0,
    fontSize: "0.875rem",
    color: colors.textSecondary,
  },
  segment: {
    display: "inline-flex",
    border: `1px solid ${colors.border}`,
    borderRadius: 8,
    overflow: "hidden",
    marginBottom: "0.75rem",
  },
  segmentButton: {
    padding: "6px 16px",
    fontSize: "0.875rem",
    border: "none",
    background: colors.background,
    color: colors.textSecondary,
    cursor: "pointer",
  },
  segmentButtonActive: {
    background: colors.primary,
    color: "#ffffff",
    fontWeight: 600,
  },
  label: {
    display: "block",
    marginBottom: "0.25rem",
    fontSize: "0.875rem",
    fontWeight: 500,
  },
  toggleRow: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.5rem",
    cursor: "pointer",
    fontSize: "0.875rem",
  },
  input: {
    padding: "8px 12px",
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: 4,
    fontSize: "0.875rem",
    width: "100%",
    maxWidth: "400px",
    boxSizing: "border-box",
    background: colors.background,
    color: colors.text,
  },
  summaryRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.75rem",
    padding: "0.75rem",
    border: `1px solid ${colors.border}`,
    borderRadius: 6,
    background: colors.surface,
  },
  summaryBody: {
    flex: 1,
    minWidth: 0,
  },
  summaryLabel: {
    fontSize: "0.75rem",
    color: colors.textSecondary,
    marginBottom: "0.125rem",
  },
  summaryValue: {
    fontSize: "0.875rem",
    color: colors.text,
    wordBreak: "break-word",
  },
  editBox: {
    padding: "0.75rem",
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: 6,
    background: colors.background,
  },
  editTitle: {
    fontSize: "0.875rem",
    fontWeight: 600,
    marginBottom: "0.5rem",
  },
  editField: {
    marginBottom: "0.75rem",
  },
  editActions: {
    display: "flex",
    gap: "0.5rem",
    marginTop: "0.5rem",
  },
  memberList: {
    border: `1px solid ${colors.border}`,
    borderRadius: 4,
    padding: "0.5rem",
    maxHeight: "320px",
    overflowY: "auto",
    background: colors.background,
  },
  memberRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    padding: "0.25rem 0.5rem",
    cursor: "pointer",
    fontSize: "0.875rem",
  },
  metaInline: {
    color: colors.textMuted,
    fontSize: "0.75rem",
  },
  metaSmall: {
    color: colors.textMuted,
    fontSize: "0.75rem",
    marginTop: "0.25rem",
  },
  muted: {
    color: colors.textMuted,
    fontSize: "0.875rem",
  },
  warn: {
    padding: "0.5rem",
    background: colors.warningSubtle,
    border: `1px solid ${colors.warning}`,
    borderRadius: 4,
    fontSize: "0.875rem",
  },
  textarea: {
    padding: "8px 12px",
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: 4,
    fontSize: "0.875rem",
    width: "100%",
    maxWidth: "500px",
    boxSizing: "border-box",
    background: colors.background,
    color: colors.text,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    resize: "vertical",
    lineHeight: 1.5,
  },
  templatePreview: {
    margin: 0,
    padding: "0.5rem 0.75rem",
    border: `1px solid ${colors.border}`,
    borderRadius: 4,
    background: colors.surface,
    fontSize: "0.8125rem",
    color: colors.text,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    maxWidth: "500px",
  },
  placeholderList: {
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    columnGap: "0.5rem",
    rowGap: "0.125rem",
    padding: "0.5rem",
    border: `1px solid ${colors.border}`,
    borderRadius: 4,
    background: colors.surface,
    fontSize: "0.75rem",
    maxWidth: "500px",
  },
  placeholderRow: {
    display: "contents",
  },
  placeholderKey: {
    color: colors.text,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  placeholderDesc: {
    color: colors.textSecondary,
  },
};
