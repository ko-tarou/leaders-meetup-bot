// 公開管理 (public-management): 公開ページからログインしたユーザーの権限を表す。
// /public/:token + パスワード認証成功時に localStorage に保存される。
//
// - "view": 閲覧専用 (主要 mutation ボタンは disable)
// - "edit": 編集可
// - null : 通常の admin (制限なし)
//
// 注意: 本ヘルパーは localStorage を毎回読むので、render 中に変わると React が
// 検知しない。ログイン直後の reload など、必要に応じて呼び出し側で対応する。

const PUBLIC_MODE_KEY = "devhub_ops:public_mode";
const PUBLIC_GRANTED_KEY = "devhub_ops:public_granted";

export type PublicMode = "view" | "edit";

// 公開モードでアクセス可能な action を表す。
// PublicEntryPage の認証成功時に保存され、route ガードで使用する。
export type PublicGranted = { eventId: string; actionType: string };

export function getPublicMode(): PublicMode | null {
  try {
    const v = localStorage.getItem(PUBLIC_MODE_KEY);
    return v === "view" || v === "edit" ? v : null;
  } catch {
    return null;
  }
}

export function setPublicMode(mode: PublicMode): void {
  try {
    localStorage.setItem(PUBLIC_MODE_KEY, mode);
  } catch {
    // noop (Private mode 等)
  }
}

export function clearPublicMode(): void {
  try {
    localStorage.removeItem(PUBLIC_MODE_KEY);
  } catch {
    // noop
  }
}

export function getPublicGranted(): PublicGranted | null {
  try {
    const raw = localStorage.getItem(PUBLIC_GRANTED_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<PublicGranted>;
    if (typeof p.eventId === "string" && typeof p.actionType === "string") {
      return { eventId: p.eventId, actionType: p.actionType };
    }
    return null;
  } catch {
    return null;
  }
}

export function setPublicGranted(granted: PublicGranted): void {
  try {
    localStorage.setItem(PUBLIC_GRANTED_KEY, JSON.stringify(granted));
  } catch {
    // noop
  }
}

export function clearPublicGranted(): void {
  try {
    localStorage.removeItem(PUBLIC_GRANTED_KEY);
  } catch {
    // noop
  }
}

export function usePublicMode(): PublicMode | null {
  return getPublicMode();
}

export function useIsReadOnly(): boolean {
  return getPublicMode() === "view";
}

export function usePublicGranted(): PublicGranted | null {
  return getPublicGranted();
}
