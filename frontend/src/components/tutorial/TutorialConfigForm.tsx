import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { EventAction, Workspace } from "../../types";
import { api } from "../../api";
import { useToast } from "../ui/Toast";
import { settingsFormStyles as s } from "../morning-standup/settingsFormStyles";
import { SingleChannelPicker } from "../ui/SingleChannelPicker";

// 宗教イベント tutorial PR2: 参加時オンボーディング投稿の設定タブ。
// config schema (backend services/tutorial.ts の TutorialConfig と一致):
//   { schemaVersion, workspaceId, triggerChannelId,
//     deliveryMode ("dm"|"channel"), postChannelId, template }
// - workspaceId 未設定 → イベント駆動 / 手動送信ともに not_configured で skip。
// - {workspace} / {user} は backend で置換される (placeholder ヒントを出す)。
// - ID は一切 UI に出さない (workspace / channel は NAME 表示)。

// backend DEFAULT_TUTORIAL_TEMPLATE と一字一句一致させる (空 config の prefill 用)。
const DEFAULT_TEMPLATE = `👋 ようこそ {workspace} へ！

■ このワークスペースについて
（ビジョン・目的をここに記載してください）

■ 表示名の命名規則
・表示名は「漢字フルネーム ( ローマ字 )」の形式で設定してください（例: 高岡 己太朗 ( Takaoka Kotaro )）
・アイコンも設定しておきましょう

■ 主要チャンネル
・#all-digital-religion-ai … 全体連絡・アナウンス
・（チャンネル名）… （用途を記載）

■ 困ったら
気軽に質問してください！`;

type DeliveryMode = "dm" | "channel";

type Config = {
  schemaVersion?: number;
  workspaceId?: string | null;
  triggerChannelId?: string | null;
  deliveryMode?: DeliveryMode;
  postChannelId?: string | null;
  template?: string;
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

export function TutorialConfigForm({
  eventId,
  action,
  onSaved,
}: {
  eventId: string;
  action: EventAction;
  onSaved: () => void;
}) {
  const toast = useToast();
  const initial = useMemo(() => parseConfig(action.config), [action.config]);

  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [workspaceId, setWorkspaceId] = useState(initial.workspaceId ?? "");
  const [triggerChannelId, setTriggerChannelId] = useState(initial.triggerChannelId ?? "");
  const [triggerChannelName, setTriggerChannelName] = useState<string>("");
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>(
    initial.deliveryMode === "channel" ? "channel" : "dm",
  );
  const [postChannelId, setPostChannelId] = useState(initial.postChannelId ?? "");
  const [postChannelName, setPostChannelName] = useState<string>("");
  const [template, setTemplate] = useState(
    initial.template && initial.template.trim() !== "" ? initial.template : DEFAULT_TEMPLATE,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // workspace 一覧 (1 件かつ未設定なら自動選択)
  useEffect(() => {
    let cancelled = false;
    api.workspaces
      .list()
      .then((list) => {
        if (cancelled) return;
        const ws = Array.isArray(list) ? list : [];
        setWorkspaces(ws);
        if (!initial.workspaceId && ws.length >= 1) setWorkspaceId(ws[0].id);
      })
      .catch(() => {
        if (!cancelled) setWorkspaces([]);
      });
    return () => {
      cancelled = true;
    };
  }, [initial.workspaceId]);

  const handleSave = async () => {
    setError(null);
    if (!workspaceId) {
      setError("ワークスペースを選択してください");
      return;
    }
    if (deliveryMode === "channel") {
      const pid = postChannelId.trim();
      if (pid === "" || !pid.startsWith("C")) {
        setError("投稿先チャンネルを選択してください");
        return;
      }
    }
    const next: Config = {
      ...initial,
      schemaVersion: 1,
      workspaceId,
      triggerChannelId: triggerChannelId.trim() === "" ? null : triggerChannelId.trim(),
      deliveryMode,
      postChannelId:
        deliveryMode === "channel" && postChannelId.trim() !== ""
          ? postChannelId.trim()
          : null,
      template: template.trim() === "" ? DEFAULT_TEMPLATE : template,
    };
    setSaving(true);
    try {
      await api.events.actions.update(eventId, action.id, {
        config: JSON.stringify(next),
      });
      toast.success("保存しました");
      onSaved();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "保存に失敗しました";
      setError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={s.wrap}>
      <h3 style={{ marginTop: 0 }}>チュートリアル 設定</h3>
      <p style={s.intro}>
        新メンバーがトリガーチャンネルに参加すると、オンボーディングガイドを自動送信します。
        ワークスペースが未設定のときは送信されません。
        文面の <code>{"{workspace}"}</code> はワークスペース名、
        <code>{"{user}"}</code> は本人メンションに置換されます。
      </p>

      {error && <div style={s.errorBox}>{error}</div>}

      <Field label="ワークスペース">
        {workspaces === null ? (
          <div style={s.hint}>取得中...</div>
        ) : workspaces.length === 0 ? (
          <div style={s.hint}>ワークスペースがありません。先に登録してください。</div>
        ) : (
          <select
            value={workspaceId}
            onChange={(e) => {
              setWorkspaceId(e.target.value);
              // workspace 切替時は channel 系をリセット (取得元 WS が変わるため)。
              setTriggerChannelId("");
              setTriggerChannelName("");
              setPostChannelId("");
              setPostChannelName("");
            }}
            disabled={saving}
            aria-label="ワークスペース"
            style={s.input}
          >
            <option value="">選択してください</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        )}
      </Field>

      <Field label="トリガーチャンネル">
        <SingleChannelPicker
          value={triggerChannelId}
          channelName={triggerChannelName}
          workspaceId={workspaceId}
          onChange={(id, name) => {
            setTriggerChannelId(id);
            setTriggerChannelName(name);
          }}
          disabled={saving}
        />
        <div style={s.hint}>このチャンネルに参加した新メンバーへ自動送信されます。</div>
      </Field>

      <Field label="送信方法">
        <select
          value={deliveryMode}
          onChange={(e) => setDeliveryMode(e.target.value as DeliveryMode)}
          disabled={saving}
          aria-label="送信方法"
          style={{ ...s.input, width: "16rem" }}
        >
          <option value="dm">本人へDM</option>
          <option value="channel">チャンネルへ投稿</option>
        </select>
      </Field>

      {deliveryMode === "channel" && (
        <Field label="投稿先チャンネル">
          <SingleChannelPicker
            value={postChannelId}
            channelName={postChannelName}
            workspaceId={workspaceId}
            onChange={(id, name) => {
              setPostChannelId(id);
              setPostChannelName(name);
            }}
            disabled={saving}
          />
        </Field>
      )}

      <Field label="案内文">
        <textarea
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          placeholder={DEFAULT_TEMPLATE}
          disabled={saving}
          rows={12}
          aria-label="案内文"
          style={{ ...s.input, fontFamily: "monospace", resize: "vertical" }}
        />
        <div style={s.hint}>
          <code>{"{workspace}"}</code> はワークスペース名、
          <code>{"{user}"}</code> は本人メンションに置換されます。
        </div>
      </Field>

      <div style={s.actions}>
        <button type="button" onClick={handleSave} disabled={saving} style={s.saveBtn}>
          {saving ? "保存中..." : "保存"}
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={s.field}>
      <label style={s.fieldLabel}>{label}</label>
      {children}
    </div>
  );
}
