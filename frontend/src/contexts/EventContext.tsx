import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { Event } from "../types";
import { api, getAdminToken } from "../api";

const STORAGE_KEY = "devhub_ops:current_event_id";

type EventContextValue = {
  events: Event[];
  currentEvent: Event | null;
  setCurrentEventId: (id: string) => void;
  refreshEvents: () => Promise<void>;
  loading: boolean;
  fetchError: string | null;
  // 005-1: admin token が未設定 / 不正な場合に true。
  // App / HomePage 側で AdminTokenPrompt の表示判定に使う。
  tokenInvalid: boolean;
};

const EventContext = createContext<EventContextValue | null>(null);

export function EventProvider({ children }: { children: ReactNode }) {
  const [events, setEvents] = useState<Event[]>([]);
  const [currentEventId, _setCurrentEventId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  });
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  // 005-1: token 未設定なら初期値 true（fetch 試行前から prompt 表示可能）
  const [tokenInvalid, setTokenInvalid] = useState<boolean>(
    () => !getAdminToken(),
  );

  useEffect(() => {
    let cancelled = false;
    api.events
      .list()
      .then((list) => {
        if (cancelled) return;
        const safeList = Array.isArray(list) ? list : [];
        setEvents(safeList);
        // ID現存チェック (ADR-0003 修正1):
        // localStorage に残った ID が events 一覧にない場合は破棄
        const stored = currentEventId;
        if (stored && !safeList.some((e) => e.id === stored)) {
          _setCurrentEventId(null);
          try {
            localStorage.removeItem(STORAGE_KEY);
          } catch {
            // noop
          }
        }
        // 初回ロード時に未設定なら一覧の先頭にフォールバック
        if (!stored && safeList.length > 0) {
          const firstId = safeList[0].id;
          _setCurrentEventId(firstId);
          try {
            localStorage.setItem(STORAGE_KEY, firstId);
          } catch {
            // noop
          }
        }
      })
      .catch((err) => {
        // 失敗時は空のまま。EventSwitcher 側は events.length===0 で表示しない。
        // 本番で「イベントがありません」が出たままになる現象の調査用に
        // ブラウザ DevTools から原因を確認できるよう console.error を残す。
        console.error("[EventContext] api.events.list() failed:", err);
        if (cancelled) return;
        // ブラウザの広告ブロッカー / プライバシー保護で API が遮断されているケース
        // (Arc / Brave / uBlock 等) を区別して案内する。
        // fetch が拡張機能でブロックされると TypeError("Failed to fetch") になる。
        const isBlocked =
          err instanceof TypeError && /Failed to fetch/i.test(err.message);
        // 005-1: 401 検出。err.status (005-2 の APIError) と err.message の両方をチェックして
        // 005-2 の merge 状態に依存せず動くようにする。
        const status = (err as { status?: number } | null)?.status;
        const message = err instanceof Error ? err.message : "";
        const isUnauthorized =
          status === 401 || /HTTP 401/i.test(message);
        if (isUnauthorized) {
          setTokenInvalid(true);
          setFetchError(
            "管理トークンが未設定または不正です。ADMIN_TOKEN を入力してください。",
          );
          return;
        }
        setFetchError(
          isBlocked
            ? "API へのリクエストがブロックされました。広告ブロッカー / プライバシー拡張機能 / ブラウザのトラッキング保護を一時的に無効にしてください。"
            : "イベント一覧の取得に失敗しました。再読み込みしてください。",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // 初回マウントのみ実行する。currentEventId は内部で参照するだけで依存に含めない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setCurrentEventId = (id: string) => {
    _setCurrentEventId(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // noop (Private mode 等)
    }
  };

  // events 作成・削除など外部変更後に手動で再取得するための関数
  const refreshEvents = async () => {
    try {
      const list = await api.events.list();
      setEvents(Array.isArray(list) ? list : []);
    } catch (e) {
      console.error("refreshEvents failed", e);
    }
  };

  const currentEvent =
    events.find((e) => e.id === currentEventId) ?? null;

  return (
    <EventContext.Provider
      value={{
        events,
        currentEvent,
        setCurrentEventId,
        refreshEvents,
        loading,
        fetchError,
        tokenInvalid,
      }}
    >
      {children}
    </EventContext.Provider>
  );
}

export function useEvents() {
  const ctx = useContext(EventContext);
  if (!ctx) throw new Error("useEvents must be used within EventProvider");
  return ctx;
}
