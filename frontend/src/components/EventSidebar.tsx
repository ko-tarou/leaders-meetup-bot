import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "../api";
import { useEvents } from "../contexts/EventContext";
import { useIsMobile } from "../hooks/useIsMobile";
import { colors } from "../styles/tokens";
import { useToast } from "./ui/Toast";

// UX 改善 Phase 1 - PR1:
// 旧 EventSwitcher (上部 dropdown, 2 クリック必要) を置き換える左サイドバー。
//
// - desktop (>= 640px): App.tsx で flex の左カラムとして「常時表示」される。
//   1 クリックでイベントを切替できる。アクティブ event はハイライト。
// - mobile (< 640px): App.tsx の MobileMenuSheet 内に <SidebarContent /> として
//   埋め込まれる。drawer の中でも同じ操作感を提供する。
//
// 設計方針:
// - イベント切替の挙動は旧 EventSwitcher と同等 (setCurrentEventId + navigate)。
// - 「+ イベント作成」モーダルは旧実装のものを移植 (UI / バリデーションそのまま)。
// - ロジックは EventContext に依存し、上位レイアウトには非依存。

const SIDEBAR_WIDTH = 256;

function eventTypeLabel(type: string): string {
  if (type === "meetup") return "ミートアップ";
  if (type === "hackathon") return "ハッカソン";
  if (type === "project") return "プロジェクト";
  return type;
}

// ============================================================================
// Desktop 用: 左カラムに常時表示するサイドバー外殻
// ============================================================================

/**
 * desktop で App.tsx の flex 左カラムとして使うサイドバー。
 * 高さは viewport 100% で、内部スクロール対応。
 */
export function EventSidebar() {
  return (
    <aside
      aria-label="イベント一覧"
      style={{
        // desktop 左カラム。content と区切るための薄いボーダー。
        width: SIDEBAR_WIDTH,
        minWidth: SIDEBAR_WIDTH,
        height: "100vh",
        position: "sticky",
        top: 0,
        borderRight: `1px solid ${colors.border}`,
        background: colors.surface,
        // HitoLink DS: sidebar に 2 段重ね card shadow を載せて、main column との
        // 深さ感を作る (元は border のみ)。
        boxShadow: "var(--shadow-card)",
        display: "flex",
        flexDirection: "column",
        // スクロールは中の list 部に任せる (header / footer は固定)
        overflow: "hidden",
      }}
    >
      <EventSidebarContent variant="desktop" />
    </aside>
  );
}

// ============================================================================
// 共通中身: desktop sidebar / mobile drawer 双方から呼ばれる
// ============================================================================

/**
 * サイドバーの中身 (title / event list / create button)。
 * - variant="desktop": 縦に伸びる sticky panel の中で使う想定。
 * - variant="mobile":  MobileMenuSheet の中で flat に並べる想定。
 *
 * variant ごとの差は微妙な余白とタイトル表示の有無のみ。
 * ロジック (event 切替 / 作成モーダル) は完全に共通。
 */
export function EventSidebarContent({
  variant,
  onNavigate,
}: {
  variant: "desktop" | "mobile";
  // mobile 時は drawer を閉じたいので click 後にコールバックを呼ぶ。
  onNavigate?: () => void;
}) {
  const { events, currentEvent, setCurrentEventId, refreshEvents, loading } =
    useEvents();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [createOpen, setCreateOpen] = useState(false);
  const isMobile = useIsMobile();

  const isDesktopVariant = variant === "desktop";

  const handleSelect = (id: string) => {
    setCurrentEventId(id);
    // 旧 EventSwitcher と同じ: actions タブに遷移。
    // 既に同じ event の actions にいる場合は navigate しても副作用は無い。
    const next = `/events/${id}/actions`;
    if (pathname !== next) {
      navigate(next);
    }
    onNavigate?.();
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
        // mobile drawer の中では padding を絞り、外側 (MobileMenuSheet) の
        // padding と重ねないようにする。
        padding: isDesktopVariant ? 0 : 0,
      }}
    >
      {/* ===== Header: タイトル (desktop のみ) ===== */}
      {isDesktopVariant && (
        <div
          style={{
            padding: "16px 16px 12px",
            borderBottom: `1px solid ${colors.border}`,
          }}
        >
          <div
            style={{
              fontSize: 12,
              color: colors.textMuted,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              marginBottom: 2,
            }}
          >
            Devhub Ops
          </div>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: colors.text,
            }}
          >
            イベント一覧
          </div>
        </div>
      )}

      {/* ===== List: イベント一覧 ===== */}
      <nav
        aria-label="イベント切替"
        style={{
          flex: 1,
          minHeight: 0,
          // 件数が多い場合の保険。desktop でも overflow させる。
          overflowY: "auto",
          padding: isDesktopVariant ? "8px 8px" : "0",
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
        {loading ? (
          <div
            style={{
              padding: "12px 12px",
              color: colors.textMuted,
              fontSize: 13,
            }}
          >
            読み込み中...
          </div>
        ) : events.length === 0 ? (
          <div
            style={{
              padding: "12px 12px",
              color: colors.textMuted,
              fontSize: 13,
              lineHeight: 1.5,
            }}
          >
            イベントがまだありません。下のボタンから作成してください。
          </div>
        ) : (
          events.map((event) => {
            const active = currentEvent?.id === event.id;
            return (
              <button
                key={event.id}
                type="button"
                onClick={() => handleSelect(event.id)}
                aria-current={active ? "page" : undefined}
                title={event.name}
                style={getEventButtonStyle(active, isMobile)}
              >
                <span style={eventNameStyle}>{event.name}</span>
                <span style={eventTypeBadgeStyle(active)}>
                  {eventTypeLabel(event.type)}
                </span>
              </button>
            );
          })
        )}
      </nav>

      {/* ===== Footer: 「+ イベント作成」ボタン ===== */}
      <div
        style={{
          padding: isDesktopVariant ? "12px 12px" : "12px 0 0",
          borderTop: isDesktopVariant ? `1px solid ${colors.border}` : "none",
          background: isDesktopVariant ? colors.surface : "transparent",
        }}
      >
        {/* HitoLink DS: 「イベント作成」は accent (warm orange) で励まし系 CTA。 */}
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="btn btn-accent btn-sm"
          style={createButtonStyle(isMobile)}
        >
          ＋ イベント作成
        </button>
      </div>

      {/* ===== 作成モーダル (旧 EventSwitcher から移植) ===== */}
      {createOpen && (
        <CreateEventModal
          onClose={() => setCreateOpen(false)}
          onCreated={async (newId) => {
            await refreshEvents();
            setCurrentEventId(newId);
            navigate(`/events/${newId}/actions`);
            setCreateOpen(false);
            onNavigate?.();
          }}
        />
      )}
    </div>
  );
}

// ============================================================================
// Styles
// ============================================================================

function getEventButtonStyle(
  active: boolean,
  isMobile: boolean,
): React.CSSProperties {
  return {
    // tap target: mobile は 44px 以上を確保
    minHeight: isMobile ? 44 : 36,
    width: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    padding: isMobile ? "10px 12px" : "8px 10px",
    border: active
      ? `1px solid ${colors.primary}`
      : `1px solid transparent`,
    borderRadius: 6,
    background: active ? colors.primarySubtle : "transparent",
    color: active ? colors.primaryActive : colors.text,
    fontSize: 14,
    fontWeight: active ? 600 : 400,
    cursor: "pointer",
    textAlign: "left",
    // 長いイベント名のはみ出し対策
    overflow: "hidden",
  };
}

const eventNameStyle: React.CSSProperties = {
  flex: 1,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  minWidth: 0,
};

function eventTypeBadgeStyle(active: boolean): React.CSSProperties {
  return {
    fontSize: 11,
    padding: "1px 6px",
    borderRadius: 999,
    background: active ? colors.background : colors.surface,
    border: `1px solid ${colors.border}`,
    color: colors.textSecondary,
    whiteSpace: "nowrap",
    flexShrink: 0,
  };
}

function createButtonStyle(isMobile: boolean): React.CSSProperties {
  return {
    width: "100%",
    minHeight: isMobile ? 44 : 36,
    padding: "8px 12px",
    border: `1px dashed ${colors.borderStrong}`,
    borderRadius: 6,
    background: colors.background,
    color: colors.text,
    fontSize: 13,
    cursor: "pointer",
  };
}

// ============================================================================
// CreateEventModal: 旧 EventSwitcher.tsx から移植
// ============================================================================

type EventType = "meetup" | "hackathon" | "project";

const EVENT_TYPES: { value: EventType; label: string }[] = [
  { value: "meetup", label: "ミートアップ" },
  { value: "hackathon", label: "ハッカソン" },
  { value: "project", label: "プロジェクト" },
];

function CreateEventModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (newId: string) => void | Promise<void>;
}) {
  const toast = useToast();
  const isMobile = useIsMobile();
  const [name, setName] = useState("");
  const [type, setType] = useState<EventType>("meetup");
  const [submitting, setSubmitting] = useState(false);

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("イベント名を入力してください");
      return;
    }
    setSubmitting(true);
    try {
      const created = await api.events.create({ type, name: trimmed });
      toast.success("イベントを作成しました");
      await onCreated(created.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "作成に失敗しました");
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: isMobile ? "stretch" : "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      {/* HitoLink DS: anim-pop-in でモーダルを spring 着地させる。 */}
      <div
        className="anim-pop-in"
        style={{
          background: "white",
          padding: isMobile ? "1rem" : "1.5rem",
          borderRadius: isMobile ? 0 : "0.5rem",
          width: isMobile ? "100%" : "min(400px, 90vw)",
          maxHeight: isMobile ? "100vh" : "90vh",
          overflow: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0 }}>新規イベント作成</h3>
        <label
          style={{
            display: "block",
            fontSize: "0.875rem",
            marginBottom: "0.25rem",
            color: colors.text,
          }}
        >
          イベント名
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={submitting}
          style={{
            width: "100%",
            padding: "0.5rem",
            marginBottom: "1rem",
            border: `1px solid ${colors.borderStrong}`,
            borderRadius: "0.25rem",
            boxSizing: "border-box",
          }}
        />
        <label
          style={{
            display: "block",
            fontSize: "0.875rem",
            marginBottom: "0.25rem",
            color: colors.text,
          }}
        >
          種別
        </label>
        <select
          value={type}
          onChange={(e) => setType(e.target.value as EventType)}
          disabled={submitting}
          style={{
            width: "100%",
            padding: "0.5rem",
            marginBottom: "1rem",
            border: `1px solid ${colors.borderStrong}`,
            borderRadius: "0.25rem",
          }}
        >
          {EVENT_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <div
          style={{
            display: "flex",
            flexDirection: isMobile ? "column" : "row",
            gap: "0.5rem",
            justifyContent: "flex-end",
          }}
        >
          {/* HitoLink DS: cancel = ghost、create = primary。 */}
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="btn btn-ghost btn-sm"
            style={{
              padding: "0.5rem 1rem",
              border: `1px solid ${colors.borderStrong}`,
              background: colors.background,
              borderRadius: "0.25rem",
              cursor: submitting ? "wait" : "pointer",
              width: isMobile ? "100%" : undefined,
            }}
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={submitting}
            className="btn btn-primary btn-sm"
            style={{
              padding: "0.5rem 1rem",
              border: "none",
              background: colors.primary,
              color: "white",
              borderRadius: "0.25rem",
              cursor: submitting ? "wait" : "pointer",
              width: isMobile ? "100%" : undefined,
            }}
          >
            {submitting ? "作成中..." : "作成"}
          </button>
        </div>
      </div>
    </div>
  );
}
