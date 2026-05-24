import { useEffect, useState, type CSSProperties } from "react";
import { api } from "../api";
import type { EventAction, EventActionType } from "../types";
import { colors } from "../styles/tokens";
import { RosterPage } from "./roster/RosterPage";
import { RoleMainTab } from "../components/role-management/RoleMainTab";

// members-tab-integration (2026-05):
// イベント詳細ページの「メンバー」タブを、サブタブ「名簿 / ロール」を
// 持つ統合 UI に置換する。それぞれの実体は既存の RosterPage / RoleMainTab を
// そのまま再利用し、新規 API / 新規 BE は追加しない。
//
// メンバータブ初回表示時に、対応する event_actions
// (member_roster / role_management) が存在しなければ自動作成する。
// 既存 actions は完全保護する (重複作成しない / config / enabled は維持)。

type SubTab = "roster" | "roles";

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
          <RoleMainTab eventId={eventId} action={roleAction} />
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

const s: Record<string, CSSProperties> = {
  subTabBar: {
    display: "flex",
    gap: "0.25rem",
    borderBottom: `1px solid ${colors.border}`,
    marginBottom: "1rem",
    overflowX: "auto",
    WebkitOverflowScrolling: "touch",
  },
  loading: {
    padding: "1.5rem",
    textAlign: "center",
    color: colors.textMuted,
    fontSize: "0.875rem",
  },
};
