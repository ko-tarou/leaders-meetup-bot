import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { colors, fontSize, radius, shadow, space } from "../../styles/tokens";

// 005-7: トースト通知。
// 既存の `alert(...)` 連発 (#58/#59/#60 R7 [must]) の置換先。
// 本 PR では Provider/Hook の新設のみで、既存 alert はそのまま残す。
// 置換は 005-8 で実施する。

type ToastKind = "info" | "success" | "error" | "warning";

type Toast = {
  id: string;
  kind: ToastKind;
  message: string;
  durationMs: number;
};

type ShowOptions = { kind?: ToastKind; durationMs?: number };

export type ToastContextValue = {
  show: (message: string, opts?: ShowOptions) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
  warning: (message: string) => void;
};

const DEFAULT_DURATION_MS = 4000;
const MAX_TOASTS = 5;

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // 自動 dismiss 用 timer の参照管理
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  const dismiss = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (message: string, opts?: ShowOptions) => {
      const id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random()}`;
      const toast: Toast = {
        id,
        kind: opts?.kind ?? "info",
        message,
        durationMs: opts?.durationMs ?? DEFAULT_DURATION_MS,
      };
      setToasts((prev) => {
        // 上限を超える場合は古いものを落とす (FIFO)
        const next = [...prev, toast];
        if (next.length <= MAX_TOASTS) return next;
        const removedCount = next.length - MAX_TOASTS;
        const removed = next.slice(0, removedCount);
        for (const t of removed) {
          const timer = timersRef.current.get(t.id);
          if (timer) {
            clearTimeout(timer);
            timersRef.current.delete(t.id);
          }
        }
        return next.slice(removedCount);
      });
      const timer = setTimeout(() => dismiss(id), toast.durationMs);
      timersRef.current.set(id, timer);
    },
    [dismiss],
  );

  // unmount 時に全 timer を掃除
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({
      show,
      success: (message: string) => show(message, { kind: "success" }),
      error: (message: string) => show(message, { kind: "error" }),
      info: (message: string) => show(message, { kind: "info" }),
      warning: (message: string) => show(message, { kind: "warning" }),
    }),
    [show],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within <ToastProvider>");
  }
  return ctx;
}

// ---- view layer ----

const kindStyles: Record<
  ToastKind,
  { background: string; border: string; color: string }
> = {
  info: {
    background: colors.primarySubtle,
    border: colors.primary,
    color: colors.text,
  },
  success: {
    background: colors.successSubtle,
    border: colors.success,
    color: colors.text,
  },
  error: {
    background: colors.dangerSubtle,
    border: colors.danger,
    color: colors.text,
  },
  warning: {
    background: colors.warningSubtle,
    border: colors.warning,
    color: colors.text,
  },
};

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;
  const containerStyle: CSSProperties = {
    position: "fixed",
    top: space.lg,
    right: space.lg,
    zIndex: 9999,
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    maxWidth: 360,
    pointerEvents: "none",
  };
  return (
    <div style={containerStyle} role="status" aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: string) => void;
}) {
  const palette = kindStyles[toast.kind];
  const style: CSSProperties = {
    pointerEvents: "auto",
    background: palette.background,
    color: palette.color,
    border: `1px solid ${palette.border}`,
    borderLeftWidth: 4,
    borderRadius: radius.md,
    padding: `${space.md} ${space.lg}`,
    fontSize: fontSize.sm,
    boxShadow: shadow.md,
    display: "flex",
    alignItems: "flex-start",
    gap: space.md,
  };
  const closeBtnStyle: CSSProperties = {
    appearance: "none",
    background: "transparent",
    border: "none",
    color: colors.textSecondary,
    cursor: "pointer",
    padding: 0,
    fontSize: fontSize.lg,
    lineHeight: 1,
    marginLeft: "auto",
  };
  return (
    <div style={style}>
      <span style={{ flex: 1, whiteSpace: "pre-wrap" }}>{toast.message}</span>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="閉じる"
        style={closeBtnStyle}
      >
        &times;
      </button>
    </div>
  );
}
