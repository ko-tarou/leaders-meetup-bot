import { useEffect, useState, type CSSProperties } from "react";
import { api } from "../api";
import type { EventAction, EventActionType } from "../types";
import { colors } from "../styles/tokens";
import { RosterPage } from "./roster/RosterPage";
import { RoleMainTab } from "../components/role-management/RoleMainTab";
import { RolesTab } from "../components/role-management/RolesTab";
import { AutoClassifyTab } from "../components/role-management/AutoClassifyTab";
import { RoleMembersTab } from "../components/role-management/RoleMembersTab";
import { RoleSyncTab } from "../components/role-management/RoleSyncTab";
import { ActionSettingsContent } from "./action-detail/ActionSettingsContent";

// members-tab-integration (2026-05):
// イベント詳細ページの「メンバー」タブを、サブタブ「名簿 / ロール」を
// 持つ統合 UI に置換する。それぞれの実体は既存の RosterPage / RoleMainTab を
// そのまま再利用し、新規 API / 新規 BE は追加しない。
//
// メンバータブ初回表示時に、対応する event_actions
// (member_roster / role_management) が存在しなければ自動作成する。
// 既存 actions は完全保護する (重複作成しない / config / enabled は維持)。
//
// fix/members-tab-role-features-restored (2026-05):
// 「ロール」サブタブ配下にさらに 5 つの level-2 サブタブを持たせて、
// ActionDetailPage (role_management) と同じ機能を再現する。これにより
// PR #272 で抜け落ちていた以下を完全復元する:
//   - 新しい人を追加 (RoleMembersTab)
//   - 差分検知 / 同期 (RoleSyncTab)
//   - 親子ロール定義・割当 (RolesTab)
//   - workspace 等の設定 (ActionSettingsContent)
// 既存コンポーネントは props 互換でそのまま再利用するため、機能の挙動は
// 役割管理アクション詳細ページと完全一致する。

type SubTab = "roster" | "roles";

// role_management の level-2 サブタブ。ActionDetailPage の subTabs と
// id を合わせて、将来統合しやすい状態を保つ。
type RoleSubTab =
  | "main"
  | "roles"
  | "auto-classify"
  | "members"
  | "sync"
  | "settings";

const ROLE_SUB_TABS: { id: RoleSubTab; label: string }[] = [
  { id: "main", label: "サマリ" },
  { id: "roles", label: "ロール" },
  { id: "auto-classify", label: "自動分類" },
  { id: "members", label: "メンバー" },
  { id: "sync", label: "同期" },
  { id: "settings", label: "設定" },
];

type Props = {
  eventId: string;
  actions: EventAction[];
  // 自動作成後、親側で actions 再 fetch を発火するためのコールバック。
  onActionsChange: () => void;
};

export function MembersTabContent({
  eventId,
  actions,
  onActionsChange,
}: Props) {
  const [subTab, setSubTab] = useState<SubTab>("roster");
  // 「ロール」level-1 タブ内の level-2 タブ。初期値は ActionDetailPage と
  // 同じ "main" (サマリ) を採用し、UX を揃える。
  const [roleSubTab, setRoleSubTab] = useState<RoleSubTab>("main");
  // ensure 中 (= 自動作成 POST が in-flight) は子コンポーネントをマウントせず
  // 「初期化中…」のプレースホルダを出す。空配列 → POST → 親 refetch → 再 render
  // という流れになる。再 render 後は既に action が揃っているので ensure 完了扱い。
  const [ensuring, setEnsuring] = useState(true);

  const rosterAction = actions.find(
    (a) => a.actionType === "member_roster",
  );
  const roleAction = actions.find(
    (a) => a.actionType === "role_management",
  );

  useEffect(() => {
    let cancelled = false;

    // 既に両方揃っているなら即 ready。
    if (rosterAction && roleAction) {
      setEnsuring(false);
      return () => {
        cancelled = true;
      };
    }

    setEnsuring(true);
    (async () => {
      const needs: { type: EventActionType }[] = [];
      if (!rosterAction) needs.push({ type: "member_roster" });
      if (!roleAction) needs.push({ type: "role_management" });
      try {
        // POST は並列で良い (異なる action_type なので衝突しない)。
        // config / enabled は BE の default に任せる (member_roster は
        // {schemaVersion:1}、それ以外は {} が入る)。
        await Promise.all(
          needs.map((n) =>
            api.events.actions.create(eventId, {
              actionType: n.type,
            }),
          ),
        );
        if (cancelled) return;
        // 親に actions 再取得を依頼し、再 render を待つ。
        // 再 render で rosterAction / roleAction が埋まれば 上の早期 return が走り
        // ensuring=false に遷移する。POST 完了時点ではまだ rosterAction が
        // undefined のまま残るので、ここでは setEnsuring(false) しない。
        // (ただし fail-soft のため API 失敗時は UI ブロックを避けて ensuring=false にする。)
        onActionsChange();
      } catch (e) {
        // fail-soft: UI は子なしの空状態に落とさず、警告だけ出してロード解除。
        console.error("[members-tab] ensure failed", e);
        if (!cancelled) setEnsuring(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // onActionsChange は親で都度新しい関数を作る場合があるが、依存に入れると
    // 無限ループになりやすい。eventId と action 有無のみで制御する。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, !!rosterAction, !!roleAction]);

  if (ensuring) {
    return (
      <div style={s.loading}>初期化中...</div>
    );
  }

  return (
    <div>
      <div style={s.subTabBar}>
        {(
          [
            { id: "roster" as const, label: "名簿" },
            { id: "roles" as const, label: "ロール" },
          ]
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setSubTab(t.id)}
            style={subTabBtn(subTab === t.id)}
            aria-pressed={subTab === t.id}
          >
            {t.label}
          </button>
        ))}
      </div>

      {subTab === "roster" &&
        (rosterAction ? (
          <RosterPage eventId={eventId} actionId={rosterAction.id} />
        ) : (
          <FallbackMessage
            text="名簿アクションを初期化できませんでした。ページを再読み込みしてください。"
          />
        ))}
      {subTab === "roles" &&
        (roleAction ? (
          <div>
            {/* level-2 サブタブ。視覚的階層をつけるため小さめ・控えめのスタイル */}
            <div style={s.roleSubTabBar} role="tablist" aria-label="ロール管理サブタブ">
              {ROLE_SUB_TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  onClick={() => setRoleSubTab(t.id)}
                  style={roleSubTabBtn(roleSubTab === t.id)}
                  aria-pressed={roleSubTab === t.id}
                  aria-selected={roleSubTab === t.id}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* 各 level-2 サブタブの本体。ActionDetailPage の role_management
                分岐と同じ props 配線を採用し、機能を完全に再現する。 */}
            {roleSubTab === "main" && (
              <RoleMainTab eventId={eventId} action={roleAction} />
            )}
            {roleSubTab === "roles" && (
              <RolesTab eventId={eventId} action={roleAction} />
            )}
            {roleSubTab === "auto-classify" && (
              <AutoClassifyTab eventId={eventId} action={roleAction} />
            )}
            {roleSubTab === "members" && (
              <RoleMembersTab eventId={eventId} action={roleAction} />
            )}
            {roleSubTab === "sync" && (
              <RoleSyncTab eventId={eventId} action={roleAction} />
            )}
            {roleSubTab === "settings" && (
              <ActionSettingsContent
                eventId={eventId}
                action={roleAction}
                onSaved={onActionsChange}
              />
            )}
          </div>
        ) : (
          <FallbackMessage
            text="ロール管理アクションを初期化できませんでした。ページを再読み込みしてください。"
          />
        ))}
    </div>
  );
}

function FallbackMessage({ text }: { text: string }) {
  return (
    <div
      style={{
        padding: "1rem",
        margin: "0.5rem 0",
        color: colors.warning,
        background: colors.warningSubtle,
        borderRadius: "0.375rem",
        fontSize: "0.875rem",
      }}
    >
      {text}
    </div>
  );
}

// ActionSubTabs と同じ見た目にして横スクロール挙動も揃える。
// 共通化したい場合は後続 PR で抽出するが、まずは表示を一致させることを優先。
function subTabBtn(active: boolean): CSSProperties {
  return {
    padding: "0.5rem 1rem",
    background: active ? colors.primary : "transparent",
    color: active ? colors.textInverse : colors.text,
    border: "none",
    cursor: "pointer",
    borderRadius: "0.25rem 0.25rem 0 0",
    fontSize: "0.875rem",
    flex: "0 0 auto",
    whiteSpace: "nowrap",
    minHeight: 40,
  };
}

// level-2 サブタブ。level-1 と区別するため一回り小さく、active 色も
// secondary 系で控えめにし、ボタンは pill 風 (角丸全体) にして見た目を
// 階層的に分ける。横スクロール挙動は level-1 と同じ。
function roleSubTabBtn(active: boolean): CSSProperties {
  return {
    padding: "0.375rem 0.75rem",
    background: active ? colors.primarySubtle : "transparent",
    color: active ? colors.primary : colors.textSecondary,
    border: active
      ? `1px solid ${colors.primary}`
      : `1px solid ${colors.border}`,
    cursor: "pointer",
    borderRadius: "999px",
    fontSize: "0.8125rem",
    fontWeight: active ? 600 : 500,
    flex: "0 0 auto",
    whiteSpace: "nowrap",
    minHeight: 36,
  };
}

const s: Record<string, CSSProperties> = {
  subTabBar: {
    display: "flex",
    gap: "0.25rem",
    borderBottom: `1px solid ${colors.border}`,
    marginBottom: "1rem",
    overflowX: "auto",
    WebkitOverflowScrolling: "touch",
  },
  // level-2 バー: 下線を消し、margin を狭めて 上位タブとの "入れ子" 感を出す。
  roleSubTabBar: {
    display: "flex",
    gap: "0.375rem",
    marginBottom: "1rem",
    overflowX: "auto",
    WebkitOverflowScrolling: "touch",
    paddingBottom: "0.25rem",
  },
  loading: {
    padding: "1.5rem",
    textAlign: "center",
    color: colors.textMuted,
    fontSize: "0.875rem",
  },
};
