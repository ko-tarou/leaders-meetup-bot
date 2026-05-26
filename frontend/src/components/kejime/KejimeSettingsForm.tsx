import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { EventAction, Workspace } from "../../types";
import { api } from "../../api";
import { useToast } from "../ui/Toast";
import { colors } from "../../styles/tokens";
import { settingsFormStyles as s } from "../morning-standup/settingsFormStyles";
import { SingleChannelPicker } from "../ui/SingleChannelPicker";
import { RoleNameDisplay } from "../role-management/RoleNameDisplay";

// 003 PR7 → PR8 → PR9: kejime_tracker アクション専用の設定タブ。
// config schema: { kejimeChannelId, roleId?, minArticleLength? }
// - PR9: ChannelSelector → SingleChannelPicker (検索 + ページング)。
//        workspace dropdown を追加 (1 件しか無ければ隠して自動選択)
// - PR8: roleId は RoleNameDisplay でロール名を表示 (config 値は維持)
// - minArticleLength は 1 以上の整数を要求

type Config = { kejimeChannelId?: string; roleId?: string; minArticleLength?: number };

const DEFAULT_MIN = 500;

function parseConfig(raw: string | null | undefined): Config {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? (o as Config) : {};
  } catch { return {}; }
}

export function KejimeSettingsForm({
  eventId, action, onSaved,
}: { eventId: string; action: EventAction; onSaved: () => void }) {
  const toast = useToast();
  const initial = useMemo(() => parseConfig(action.config), [action.config]);
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [kejimeChannelId, setKejimeChannelId] = useState(initial.kejimeChannelId ?? "");
  const [kejimeChannelName, setKejimeChannelName] = useState<string>("");
  const [minArticleLength, setMinArticleLength] = useState(
    String(initial.minArticleLength ?? DEFAULT_MIN),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // PR9: workspace 一覧 (1 件なら自動選択)
  useEffect(() => {
    let cancelled = false;
    api.workspaces.list()
      .then((list) => {
        if (cancelled) return;
        const ws = Array.isArray(list) ? list : [];
        setWorkspaces(ws);
        if (ws.length >= 1) setWorkspaceId(ws[0].id);
      })
      .catch(() => { if (!cancelled) setWorkspaces([]); });
    return () => { cancelled = true; };
  }, []);

  const minParsed = Number(minArticleLength);
  const minInvalid =
    minArticleLength.trim() === "" || !Number.isInteger(minParsed) || minParsed < 1;

  const handleSave = async () => {
    setError(null);
    // ChannelSelector は valid な channelId しか返さないが、念のため "C" prefix 検証は維持
    const cid = kejimeChannelId.trim();
    if (cid !== "" && !cid.startsWith("C")) {
      setError("正しいけじめチャンネルを選択してください");
      return;
    }
    if (minInvalid) {
      setError("記事の最小文字数は 1 以上の整数で入力してください");
      return;
    }
    const next: Config = { ...initial, kejimeChannelId: cid, minArticleLength: minParsed };

    setSaving(true);
    try {
      await api.events.actions.update(eventId, action.id, { config: JSON.stringify(next) });
      toast.success("保存しました");
      onSaved();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "保存に失敗しました";
      setError(msg);
      toast.error(msg);
    } finally { setSaving(false); }
  };

  return (
    <div style={s.wrap}>
      <h3 style={{ marginTop: 0 }}>けじめ管理 設定</h3>
      <p style={s.intro}>
        けじめチャンネルへの記事 URL 申請 / 遅刻ステータス自動再投稿 / いいね承認の設定です。
        チャンネル未選択のときは cron が skip します。
      </p>

      {error && <div style={s.errorBox}>{error}</div>}

      {workspaces !== null && workspaces.length >= 2 && (
        <Field label="ワークスペース">
          <select
            value={workspaceId}
            onChange={(e) => { setWorkspaceId(e.target.value); setKejimeChannelId(""); setKejimeChannelName(""); }}
            disabled={saving} aria-label="ワークスペース" style={s.input}
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
        </Field>
      )}

      <Field label="けじめチャンネル">
        {/* PR11: 初期値時 channelName 未取得でも channel ID は出さない。 */}
        <SingleChannelPicker
          value={kejimeChannelId}
          channelName={kejimeChannelName}
          workspaceId={workspaceId}
          onChange={(id, name) => { setKejimeChannelId(id); setKejimeChannelName(name); }}
          disabled={saving}
        />
      </Field>

      <Field label="勉強会チーム ロール">
        <div aria-label="勉強会チーム ロール">
          <RoleNameDisplay roleId={initial.roleId ?? null} />
        </div>
        <div style={s.hint}>
          変更したい場合は「メンバー」タブ → ロール → 勉強会チーム から行ってください。
        </div>
      </Field>

      <Field label="記事の最小文字数">
        <input
          type="number" min={1} step={1} value={minArticleLength}
          onChange={(e) => setMinArticleLength(e.target.value)}
          disabled={saving} aria-invalid={minInvalid} aria-label="記事の最小文字数"
          style={{
            ...s.input, width: "10rem",
            ...(minInvalid ? { borderColor: colors.danger } : {}),
          }}
        />
        <div style={s.hint}>
          default は {DEFAULT_MIN}。これ未満の記事は自動却下されます。
        </div>
      </Field>

      <div style={s.tipBox}>
        <strong>💡 ヒント</strong>
        <ul style={s.tipList}>
          <li>記事は Qiita のみ受付 (https://qiita.com/&lt;user&gt;/items/&lt;id&gt;)</li>
          <li>「勉強会チーム」のいいねリアクションで承認 (自分自身は不可)</li>
          <li>{DEFAULT_MIN}文字未満は自動却下</li>
        </ul>
      </div>

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
