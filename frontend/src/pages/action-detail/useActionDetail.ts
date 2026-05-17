import { useEffect, useRef, useState } from "react";
import {
  useNavigate,
  useParams,
  useSearchParams,
  type NavigateFunction,
} from "react-router-dom";
import { api } from "../../api";
import type { EventAction, EventActionType } from "../../types";
import { getSubTabs } from "./subTabs";

// Phase4-3: ActionDetailPage の状態・副作用ロジックを純抽出したフック。
//
// 重要: hook 呼び出し順・useEffect の依存配列・副作用の発火タイミング・
// URL 同期の挙動を元 ActionDetailPage と一字一句等価に保つ。
// (元の useParams → useNavigate → useSearchParams → useState ×4 →
//  useEffect(prevActionType) → useEffect(fetch) の順序をそのまま踏襲)

export type UseActionDetailResult = {
  eventId: string | undefined;
  actionType: string | undefined;
  navigate: NavigateFunction;
  action: EventAction | null;
  loading: boolean;
  subTab: string;
  setSubTab: (next: string) => void;
  bumpRefresh: () => void;
};

export function useActionDetail(): UseActionDetailResult {
  const { eventId, actionType } = useParams<{
    eventId: string;
    actionType: string;
  }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [action, setAction] = useState<EventAction | null>(null);
  const [loading, setLoading] = useState(true);

  // subTab は URL クエリ ?tab=<id> に永続化する (リロード復元・共有可能)。
  // 初期値は URL の tab を getSubTabs に照合し、存在しない id なら "main"。
  const resolveSubTabFromUrl = (): string => {
    const fromUrl = searchParams.get("tab");
    if (!fromUrl) return "main";
    const valid = getSubTabs(actionType as EventActionType).some(
      (t) => t.id === fromUrl,
    );
    return valid ? fromUrl : "main";
  };
  const [subTab, setSubTabState] = useState<string>(resolveSubTabFromUrl);
  const [refreshKey, setRefreshKey] = useState(0);

  // subTab 変更は state + URL クエリを同期する。
  // 値が変わった時のみ書き込み、replace:true で履歴を汚さない (無限ループ防止)。
  const setSubTab = (next: string) => {
    setSubTabState(next);
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (next === "main") p.delete("tab");
        else p.set("tab", next);
        return p;
      },
      { replace: true },
    );
  };

  // Sprint 005-tabs: actionType が切り替わったら subTab を必ず "main" に戻す。
  // schedule_polling は他 actionType と subTab の id 体系が異なるため、
  // 残留した古い subTab id（例: "settings"）でフォールスルーすると
  // 何も表示されないバグになる。
  // ただし「同一アクションのリロード」では URL の tab を尊重したいので、
  // actionType が実際に変化した時だけ "main" に戻す (初回マウントは除外)。
  const prevActionTypeRef = useRef<string | undefined>(actionType);
  useEffect(() => {
    if (prevActionTypeRef.current === actionType) return;
    prevActionTypeRef.current = actionType;
    setSubTab("main");
    // setSubTab は安定参照ではないが actionType 変化時のみ実行する意図。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionType]);

  // action 取得。初回ロード (eventId/actionType 変化) のみ loading を立て
  // 「読み込み中」表示にする。refreshKey 変化 (保存後の再取得) では loading を
  // 立てず、既存 action を表示したまま裏で差し替える。これにより保存後も
  // NotificationsTab 等の子コンポーネントがアンマウントされず mode が保持される。
  const fetchKeyRef = useRef<string>("");
  useEffect(() => {
    if (!eventId || !actionType) return;
    let cancelled = false;
    const fetchKey = `${eventId}::${actionType}`;
    const isInitial = fetchKeyRef.current !== fetchKey;
    fetchKeyRef.current = fetchKey;
    if (isInitial) setLoading(true);
    api.events.actions
      .list(eventId)
      .then((list) => {
        if (cancelled) return;
        const found = (Array.isArray(list) ? list : []).find(
          (a) => a.actionType === actionType,
        );
        setAction(found ?? null);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setAction(null);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, actionType, refreshKey]);

  const bumpRefresh = () => setRefreshKey((k) => k + 1);

  return {
    eventId,
    actionType,
    navigate,
    action,
    loading,
    subTab,
    setSubTab,
    bumpRefresh,
  };
}
