import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { EventAction, SlackRole, Workspace } from "../../types";
import { api } from "../../api";
import { useToast } from "../ui/Toast";
import { settingsFormStyles as s } from "../morning-standup/settingsFormStyles";
import { SingleChannelPicker } from "../ui/SingleChannelPicker";

// 宗教イベント PR7: whitelist アクション専用の設定タブ。
// config schema: { workspaceId, roleId, notifyChannelId }
// - workspaceId: 投稿元 / 名前解決に使う Slack workspace (この event 専用)
// - roleId:      ホワイトリスト参加者となるロール (= role_management のロール)
// - notifyChannelId: 全会一致通知を投稿するチャンネル
//
// ID は一切 UI に出さない (workspace / role / channel は NAME 表示)。
// role 名は role_management アクションの GET .../roles から取得する。

type Config = {
  workspaceId?: string;
  roleId?: string;
  notifyChannelId?: string;
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

export function WhitelistSettingsForm({
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
  const [roles, setRoles] = useState<SlackRole[] | null>(null);
  const [roleId, setRoleId] = useState(initial.roleId ?? "");
  const [notifyChannelId, setNotifyChannelId] = useState(initial.notifyChannelId ?? "");
  const [notifyChannelName, setNotifyChannelName] = useState<string>("");
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

  // role 一覧: この event の role_management アクションのロールを名前で出す。
  // (role_management が複数あっても、ロールはすべて連結して候補に並べる)
  useEffect(() => {
    let cancelled = false;
    setRoles(null);
    api.events.actions
      .list(eventId)
      .then(async (list) => {
        const rmActions = (Array.isArray(list) ? list : []).filter(
          (a) => a.actionType === "role_management",
        );
        const lists = await Promise.all(
          rmActions.map((a) =>
            api.roles.list(eventId, a.id).catch(() => [] as SlackRole[]),
          ),
        );
        if (cancelled) return;
        setRoles(lists.flat());
      })
      .catch(() => {
        if (!cancelled) setRoles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  const handleSave = async () => {
    setError(null);
    if (!workspaceId) {
      setError("ワークスペースを選択してください");
      return;
    }
    if (!roleId) {
      setError("ホワイトリストのロールを選択してください");
      return;
    }
    const cid = notifyChannelId.trim();
    if (cid === "" || !cid.startsWith("C")) {
      setError("通知チャンネルを選択してください");
      return;
    }
    const next: Config = {
      ...initial,
      workspaceId,
      roleId,
      notifyChannelId: cid,
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
      <h3 style={{ marginTop: 0 }}>ホワイトリスト 設定</h3>
      <p style={s.intro}>
        ホワイトリスト参加者 (ロール) の全会一致を集計し、合意成立時に通知チャンネルへ投稿します。
        この設定は専用ワークスペース向けです。ワークスペース / ロール / 通知チャンネルを設定してください。
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
              setNotifyChannelId("");
              setNotifyChannelName("");
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

      <Field label="ホワイトリスト ロール">
        {roles === null ? (
          <div style={s.hint}>取得中...</div>
        ) : roles.length === 0 ? (
          <div style={s.hint}>
            ロールがありません。「メンバー」タブ → ロール から作成してください。
          </div>
        ) : (
          <select
            value={roleId}
            onChange={(e) => setRoleId(e.target.value)}
            disabled={saving}
            aria-label="ホワイトリスト ロール"
            style={s.input}
          >
            <option value="">選択してください</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        )}
        <div style={s.hint}>
          このロールのメンバーが全会一致の対象 (参加者) になります。
        </div>
      </Field>

      <Field label="通知チャンネル">
        <SingleChannelPicker
          value={notifyChannelId}
          channelName={notifyChannelName}
          workspaceId={workspaceId}
          onChange={(id, name) => {
            setNotifyChannelId(id);
            setNotifyChannelName(name);
          }}
          disabled={saving}
        />
        <div style={s.hint}>全会一致が成立したときに、このチャンネルへ通知を投稿します。</div>
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
