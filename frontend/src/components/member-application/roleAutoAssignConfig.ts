import type { EventAction } from "../../types";

// participation-form Phase2:
// ロール自動割当 config の型 / 解析ヘルパ / ラベルマップ。
//
// ParticipationFormsTab (一覧表示) と RoleAutoAssignSettings (マッピング設定)
// の双方から参照するため、重複定義を避けてここに集約する。値・ロジックは
// 旧 ParticipationFormsTab から一字一句そのまま移設 (振る舞い不変)。

// === roleAutoAssign config 型 (BE 仕様と一対一) ===
export const ACTIVITY_KEYS = ["event", "dev", "both"] as const;
export const DEV_ROLE_KEYS = [
  "pm",
  "frontend",
  "backend",
  "android",
  "ios",
  "infra",
] as const;
export type ActivityKey = (typeof ACTIVITY_KEYS)[number];
export type DevRoleKey = (typeof DEV_ROLE_KEYS)[number];

export type RoleAutoAssignConfig = {
  enabled: boolean;
  roleManagementActionId: string;
  workspaceId: string;
  activity: Record<ActivityKey, string[]>;
  devRole: Record<DevRoleKey, string[]>;
};

export function emptyMap<K extends string>(
  keys: readonly K[],
): Record<K, string[]> {
  return keys.reduce(
    (acc, k) => {
      acc[k] = [];
      return acc;
    },
    {} as Record<K, string[]>,
  );
}

export function strArr(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : [];
}

/** action.config.roleAutoAssign を安全に読む。未設定なら空の構造を返す。 */
export function readRoleAutoAssign(action: EventAction): RoleAutoAssignConfig {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(action.config || "{}");
    if (parsed && typeof parsed === "object") {
      const r = (parsed as Record<string, unknown>).roleAutoAssign;
      if (r && typeof r === "object") raw = r as Record<string, unknown>;
    }
  } catch {
    raw = {};
  }
  const a = (raw.activity ?? {}) as Record<string, unknown>;
  const d = (raw.devRole ?? {}) as Record<string, unknown>;
  return {
    enabled: Boolean(raw.enabled),
    roleManagementActionId:
      typeof raw.roleManagementActionId === "string"
        ? raw.roleManagementActionId
        : "",
    workspaceId: typeof raw.workspaceId === "string" ? raw.workspaceId : "",
    activity: ACTIVITY_KEYS.reduce(
      (acc, k) => {
        acc[k] = strArr(a[k]);
        return acc;
      },
      emptyMap(ACTIVITY_KEYS),
    ),
    devRole: DEV_ROLE_KEYS.reduce(
      (acc, k) => {
        acc[k] = strArr(d[k]);
        return acc;
      },
      emptyMap(DEV_ROLE_KEYS),
    ),
  };
}

// ラベル変換マップ。BE / フォームの選択肢キーと一対一対応。
// 設定セクションと一覧表示の双方で利用する。
export const ACTIVITY_LABEL: Record<string, string> = {
  event: "イベント運営",
  dev: "チーム開発",
  both: "両方",
};
export const DEV_ROLE_LABEL: Record<string, string> = {
  pm: "PM",
  frontend: "フロントエンド",
  backend: "バックエンド",
  android: "Android",
  ios: "iOS",
  infra: "インフラ",
};
