import { useEffect, useRef } from "react";

/**
 * Google Form 的な「下書きの自動保存」を localStorage で実現する軽量フック。
 *
 * - 認証不要・バックエンド変更なし。入力途中でリロード/タブを閉じても値が消えない。
 * - 端末ローカルのみ (サーバーには送らない)。送信成功・明示破棄でクリアする前提。
 * - localStorage が使えない/例外時は握り潰す (fail-soft)。自動保存が壊れても
 *   フォーム本体は通常どおり動く。
 *
 * key はフォーム識別子 (+ イベント/ユーザー識別) を含めて衝突を避ける。
 * 例: `apply:${eventId}`。
 */
const PREFIX = "lmb:draft:";
const DEBOUNCE_MS = 400;

function storageKey(key: string): string {
  return PREFIX + key;
}

/** マウント時などに下書きを同期的に読む。無効/破損時は null (fail-soft)。 */
export function loadFormDraft<T>(key: string | null): T | null {
  if (!key) return null;
  try {
    const raw = localStorage.getItem(storageKey(key));
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** 下書きを破棄する (送信成功・明示破棄時に呼ぶ)。例外は握り潰す。 */
export function clearFormDraft(key: string | null): void {
  if (!key) return;
  try {
    localStorage.removeItem(storageKey(key));
  } catch {
    // fail-soft: localStorage 不可でも通常動作を妨げない
  }
}

/**
 * value の変化を debounce して localStorage に保存する。
 * key が null の間は何もしない (eventId 未解決など)。
 */
export function useFormDraft<T>(key: string | null, value: T): void {
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    if (!key) return;
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(
          storageKey(key),
          JSON.stringify(valueRef.current),
        );
      } catch {
        // fail-soft: 保存できなくてもフォームは動く
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [key, value]);
}
