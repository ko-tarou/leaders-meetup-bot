// Phase4-2: 旧 frontend/src/api.ts (1010 行) をドメイン別ファイルに分割した
// 共有基盤モジュール。request<T>/publicRequest<T>/getAdminToken 等の実装は
// 一字一句不変で、各ドメインモジュールがここを import して API メソッドを構築する。

const BASE = "/api";

// 005-1: admin Bearer トークン管理
// localStorage に保存し、各 API リクエストに x-admin-token header として自動注入する。
const ADMIN_TOKEN_KEY = "devhub_ops:admin_token";

export function getAdminToken(): string | null {
  try {
    return localStorage.getItem(ADMIN_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setAdminToken(token: string): void {
  try {
    localStorage.setItem(ADMIN_TOKEN_KEY, token);
  } catch {
    // noop（Private mode 等で localStorage 使用不可）
  }
}

export function clearAdminToken(): void {
  try {
    localStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch {
    // noop
  }
}

export class APIError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly body: string,
  ) {
    super(`HTTP ${status} ${statusText}: ${body.slice(0, 200)}`);
    this.name = "APIError";
  }
}

export async function request<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options?.headers as Record<string, string> | undefined),
  };
  const token = getAdminToken();
  if (token) headers["x-admin-token"] = token;

  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
  });

  // #113 (APIError) でカバーされるので、#114 の手書き 401 throw は不要
  if (!res.ok) {
    let body = "";
    try {
      body = await res.text();
    } catch {
      // noop
    }
    throw new APIError(res.status, res.statusText, body);
  }
  // 一部の API（DELETE 等）は body 空のことがあるので、204 はそのまま undefined を返す
  if (res.status === 204) return undefined as T;
  // body が空文字列の場合 res.json() は SyntaxError を投げるので守る
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new APIError(res.status, res.statusText, text);
  }
}

// participation-form Phase1 PR3: 公開エンドポイント専用 fetch。
// request<T>() は getAdminToken() を x-admin-token として常に注入するため、
// admin 認証不要の公開フォーム (/participation/*) では使えない
// (PublicApplyPage が event/availability を素の fetch で叩くのと同方針)。
// このヘルパは token を一切注入せず、エラー時は APIError を投げる。
export async function publicRequest<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) {
    let body = "";
    try {
      body = await res.text();
    } catch {
      // noop
    }
    throw new APIError(res.status, res.statusText, body);
  }
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new APIError(res.status, res.statusText, text);
  }
}
