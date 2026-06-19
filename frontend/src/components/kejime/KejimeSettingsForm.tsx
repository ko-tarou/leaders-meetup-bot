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

type MessageTemplates = {
  approved?: string;
  rejectedShort?: string;
  rejectedDomain?: string;
  rejectedFetchError?: string;
};
type LatePointWeights = { p1: number; p2: number; p3: number };
type Config = {
  kejimeChannelId?: string; roleId?: string;
  // charsPerPoint: ペナルティ記事の 1pt あたり必要文字数 (旧 minArticleLength)。
  charsPerPoint?: number; minArticleLength?: number;
  latePointWeights?: LatePointWeights;
  messageTemplates?: MessageTemplates;
};

const DEFAULT_MIN = 1000;
const DEFAULT_WEIGHTS: LatePointWeights = { p1: 70, p2: 25, p3: 5 };

// PR15: 通知文面 textarea の placeholder ヒント。実 default は backend 側で適用。
const TPL_DEFAULTS: Record<keyof MessageTemplates, string> = {
  approved: "🎉 <@{user}> の記事を承認しました (-1pt → {newPoints}pt)",
  rejectedShort: "記事の分量が少ないため却下です ({length}文字 / 必要 {minLength}文字)。",
  rejectedDomain: "Qiita 記事 URL のみ受け付けています。",
  rejectedFetchError: "記事取得に失敗しました。admin の手動承認をお待ちください。",
};

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
  // charsPerPoint は明示キー優先、無ければ旧 minArticleLength を流用 (後方互換)。
  const [charsPerPoint, setCharsPerPoint] = useState(
    String(initial.charsPerPoint ?? initial.minArticleLength ?? DEFAULT_MIN),
  );
  // 遅刻ガチャ確率 (%)。1pt/2pt/3pt。合計 100 を要求。
  const initWeights = initial.latePointWeights ?? DEFAULT_WEIGHTS;
  const [p1, setP1] = useState(String(initWeights.p1 ?? DEFAULT_WEIGHTS.p1));
  const [p2, setP2] = useState(String(initWeights.p2 ?? DEFAULT_WEIGHTS.p2));
  const [p3, setP3] = useState(String(initWeights.p3 ?? DEFAULT_WEIGHTS.p3));
  // PR15: 通知文面 4 種 (空欄なら backend で default 文言)。
  const initialTpls = initial.messageTemplates ?? {};
  const [tplApproved, setTplApproved] = useState(initialTpls.approved ?? "");
  const [tplRejectedShort, setTplRejectedShort] = useState(initialTpls.rejectedShort ?? "");
  const [tplRejectedDomain, setTplRejectedDomain] = useState(initialTpls.rejectedDomain ?? "");
  const [tplRejectedFetchError, setTplRejectedFetchError] = useState(
    initialTpls.rejectedFetchError ?? "",
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

  const minParsed = Number(charsPerPoint);
  const minInvalid =
    charsPerPoint.trim() === "" || !Number.isInteger(minParsed) || minParsed < 1;

  // 遅刻ガチャ確率の検証: 各値 0 以上の整数かつ合計 100。
  const w1 = Number(p1), w2 = Number(p2), w3 = Number(p3);
  const weightsParseBad =
    [p1, p2, p3].some((s) => s.trim() === "") ||
    ![w1, w2, w3].every((n) => Number.isInteger(n) && n >= 0);
  const weightsSum = w1 + w2 + w3;
  const weightsInvalid = weightsParseBad || weightsSum !== 100;

  const handleSave = async () => {
    setError(null);
    // ChannelSelector は valid な channelId しか返さないが、念のため "C" prefix 検証は維持
    const cid = kejimeChannelId.trim();
    if (cid !== "" && !cid.startsWith("C")) {
      setError("正しいけじめチャンネルを選択してください");
      return;
    }
    if (minInvalid) {
      setError("1pt あたりの文字数は 1 以上の整数で入力してください");
      return;
    }
    if (weightsParseBad) {
      setError("遅刻ガチャの確率は 0 以上の整数で入力してください");
      return;
    }
    if (weightsSum !== 100) {
      setError(`遅刻ガチャの確率は合計 100% にしてください (現在 ${weightsSum}%)`);
      return;
    }
    // PR15: messageTemplates は空文字を保持して保存する (空 = default を使う合図)。
    const messageTemplates: MessageTemplates = {
      approved: tplApproved,
      rejectedShort: tplRejectedShort,
      rejectedDomain: tplRejectedDomain,
      rejectedFetchError: tplRejectedFetchError,
    };
    const next: Config = {
      ...initial, kejimeChannelId: cid,
      // charsPerPoint を正本に保存しつつ、後方互換のため minArticleLength も同値で残す。
      charsPerPoint: minParsed, minArticleLength: minParsed,
      latePointWeights: { p1: w1, p2: w2, p3: w3 },
      messageTemplates,
    };

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

      <Field label="1pt あたりの文字数 (ペナルティ記事)">
        <input
          type="number" min={1} step={1} value={charsPerPoint}
          onChange={(e) => setCharsPerPoint(e.target.value)}
          disabled={saving} aria-invalid={minInvalid} aria-label="1pt あたりの文字数"
          style={{
            ...s.input, width: "10rem",
            ...(minInvalid ? { borderColor: colors.danger } : {}),
          }}
        />
        <div style={s.hint}>
          default は {DEFAULT_MIN}。ペナルティは遅刻イベント単位で、各イベントごとに記事 1 本
          (そのイベントのガチャ pt x この値・その日のテーマ準拠) が必要です
          (1pt={DEFAULT_MIN}字 / 2pt={DEFAULT_MIN * 2}字 / 3pt={DEFAULT_MIN * 3}字)。これ未満は自動却下。
          別イベントを 1 本に合算してクリアはできません。
        </div>
      </Field>

      <Field label="遅刻ガチャ確率 (%)">
        <div style={{ display: "flex", gap: "0.75rem", alignItems: "flex-end", flexWrap: "wrap" }}>
          {([
            ["1pt", p1, setP1] as const,
            ["2pt", p2, setP2] as const,
            ["3pt", p3, setP3] as const,
          ]).map(([label, val, set]) => (
            <label key={label} style={{ display: "flex", flexDirection: "column", fontSize: "0.85rem" }}>
              {label}
              <input
                type="number" min={0} step={1} value={val}
                onChange={(e) => set(e.target.value)}
                disabled={saving} aria-invalid={weightsInvalid}
                aria-label={`遅刻ガチャ確率 ${label}`}
                style={{
                  ...s.input, width: "6rem",
                  ...(weightsInvalid ? { borderColor: colors.danger } : {}),
                }}
              />
            </label>
          ))}
          <span style={{ fontSize: "0.85rem", color: weightsSum === 100 ? colors.text : colors.danger }}>
            合計 {Number.isFinite(weightsSum) ? weightsSum : "?"}%
          </span>
        </div>
        <div style={s.hint}>
          遅刻時に 1〜3pt をサーバー側で抽選します。default は 1pt=70 / 2pt=25 / 3pt=5。
          合計はちょうど 100% にしてください。
        </div>
      </Field>

      <Field label="通知文面 (承認時)">
        <textarea
          value={tplApproved} onChange={(e) => setTplApproved(e.target.value)}
          disabled={saving} aria-label="通知文面 (承認時)"
          placeholder={TPL_DEFAULTS.approved}
          style={{ ...s.input, minHeight: "3rem", fontFamily: "inherit" }}
        />
        <div style={s.hint}>
          placeholder: {"{user}"} (Slack user id), {"{newPoints}"}, {"{url}"}。
          空欄なら default 文言が使われます。
        </div>
      </Field>

      <Field label="通知文面 (却下: 文字数不足)">
        <textarea
          value={tplRejectedShort} onChange={(e) => setTplRejectedShort(e.target.value)}
          disabled={saving} aria-label="通知文面 (却下: 文字数不足)"
          placeholder={TPL_DEFAULTS.rejectedShort}
          style={{ ...s.input, minHeight: "3rem", fontFamily: "inherit" }}
        />
        <div style={s.hint}>
          placeholder: {"{length}"}, {"{minLength}"}, {"{user}"}, {"{url}"}。空欄なら default。
        </div>
      </Field>

      <Field label="通知文面 (却下: 非 Qiita ドメイン)">
        <textarea
          value={tplRejectedDomain} onChange={(e) => setTplRejectedDomain(e.target.value)}
          disabled={saving} aria-label="通知文面 (却下: 非 Qiita ドメイン)"
          placeholder={TPL_DEFAULTS.rejectedDomain}
          style={{ ...s.input, minHeight: "3rem", fontFamily: "inherit" }}
        />
        <div style={s.hint}>placeholder: {"{user}"}, {"{url}"}。空欄なら default。</div>
      </Field>

      <Field label="通知文面 (却下: 記事取得失敗)">
        <textarea
          value={tplRejectedFetchError}
          onChange={(e) => setTplRejectedFetchError(e.target.value)}
          disabled={saving} aria-label="通知文面 (却下: 記事取得失敗)"
          placeholder={TPL_DEFAULTS.rejectedFetchError}
          style={{ ...s.input, minHeight: "3rem", fontFamily: "inherit" }}
        />
        <div style={s.hint}>placeholder: {"{user}"}, {"{url}"}。空欄なら default。</div>
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
