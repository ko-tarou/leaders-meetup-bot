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
import { Button } from "./Button";

// 005-7: confirm() 代替の Promise ベース ConfirmDialog。
// 既存コードは window.confirm() で同期 UI を出していたが、
// - スタイルがブラウザ依存
// - フォーカストラップ・ESC・overlay クリックの一貫挙動を持てない
// - destructive な操作で危険色を強調できない
// という弱点があった (multi-review #58/#60/#62 R7 [must])。
//
// API:
//   const { confirm } = useConfirm();
//   const ok = await confirm({ message: "削除しますか?", variant: "danger" });
//
// 本 PR では呼び出し側の置換は行わない (005-8 で実施)。

export type ConfirmOptions = {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "danger";
};

export type ConfirmContextValue = {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
};

type QueueItem = {
  opts: ConfirmOptions;
  resolve: (v: boolean) => void;
};

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  // 同時に confirm が複数呼ばれた場合は queue で順次表示
  const [current, setCurrent] = useState<QueueItem | null>(null);
  const queueRef = useRef<QueueItem[]>([]);

  const dequeue = useCallback(() => {
    const next = queueRef.current.shift() ?? null;
    setCurrent(next);
  }, []);

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        const item: QueueItem = { opts, resolve };
        if (current === null && queueRef.current.length === 0) {
          setCurrent(item);
        } else {
          queueRef.current.push(item);
        }
      }),
    [current],
  );

  const handleResolve = useCallback(
    (result: boolean) => {
      if (!current) return;
      current.resolve(result);
      dequeue();
    },
    [current, dequeue],
  );

  const value = useMemo<ConfirmContextValue>(() => ({ confirm }), [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {current && (
        <ConfirmDialogView item={current} onResolve={handleResolve} />
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmContextValue {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error("useConfirm must be used within <ConfirmProvider>");
  }
  return ctx;
}

// ---- view layer ----

function ConfirmDialogView({
  item,
  onResolve,
}: {
  item: QueueItem;
  onResolve: (v: boolean) => void;
}) {
  const {
    title,
    message,
    confirmLabel = "OK",
    cancelLabel = "キャンセル",
    variant = "default",
  } = item.opts;

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // 初期フォーカス: destructive のときは cancel に置く
  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    const target =
      variant === "danger" ? cancelBtnRef.current : confirmBtnRef.current;
    target?.focus();
    return () => {
      // クローズ時に呼び元へフォーカスを戻す
      previouslyFocusedRef.current?.focus?.();
    };
  }, [variant]);

  // ESC で cancel
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onResolve(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onResolve]);

  // 簡易 focus trap: dialog 内の focusable 要素間で Tab を循環。
  // 今回は cancel / confirm の 2 つしかフォーカス先がないので、
  // Tab/Shift+Tab で 2 つの間を巡回させれば十分。
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const focusables = [cancelBtnRef.current, confirmBtnRef.current].filter(
      (el): el is HTMLButtonElement => el !== null,
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  const overlayStyle: CSSProperties = {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.45)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 9998,
    padding: space.lg,
  };
  const dialogStyle: CSSProperties = {
    background: colors.background,
    borderRadius: radius.lg,
    boxShadow: shadow.lg,
    maxWidth: 420,
    width: "100%",
    padding: `${space.xl} ${space.xl}`,
    color: colors.text,
    fontSize: fontSize.sm,
    lineHeight: 1.5,
  };
  const titleStyle: CSSProperties = {
    margin: 0,
    marginBottom: space.md,
    fontSize: fontSize.lg,
    fontWeight: 600,
  };
  const messageStyle: CSSProperties = {
    margin: 0,
    marginBottom: space.xl,
    color: colors.text,
    whiteSpace: "pre-wrap",
  };
  const actionsStyle: CSSProperties = {
    display: "flex",
    justifyContent: "flex-end",
    gap: space.sm,
  };

  return (
    <div
      style={overlayStyle}
      onClick={(e) => {
        // overlay クリックで cancel (dialog 内クリックは伝播しない)
        if (e.target === e.currentTarget) onResolve(false);
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? "ds-confirm-title" : undefined}
        aria-describedby="ds-confirm-message"
        style={dialogStyle}
        onKeyDown={handleKeyDown}
      >
        {title && (
          <h2 id="ds-confirm-title" style={titleStyle}>
            {title}
          </h2>
        )}
        <p id="ds-confirm-message" style={messageStyle}>
          {message}
        </p>
        <div style={actionsStyle}>
          <Button
            ref={cancelBtnRef}
            variant="secondary"
            onClick={() => onResolve(false)}
          >
            {cancelLabel}
          </Button>
          <Button
            ref={confirmBtnRef}
            variant={variant === "danger" ? "danger" : "primary"}
            onClick={() => onResolve(true)}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
