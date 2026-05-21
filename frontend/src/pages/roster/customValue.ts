// 名簿管理 PR5b: カスタム列 値の表示/入力フォーマット共通関数。
// 一覧表 (read-only) とサイドパネル (編集) で同じ parse/format を使う。
import type { RosterColumnType } from "../../types";

/** 一覧表セルの表示。null/未設定は "-"、number は NaN を弾く。 */
export function formatCustomValue(type: RosterColumnType, value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  if (type === "number") {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? String(n) : "-";
  }
  return String(value);
}

/** `<input>` value 属性に渡す string 化 (null は空文字)。 */
export function toInputValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

/** input の raw → 保存用 JSON 値。空文字は null (=削除)。number は parse。 */
export function fromInputValue(type: RosterColumnType, raw: string): unknown {
  if (raw === "") return null;
  if (type !== "number") return raw;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** select 列の options を JSON 文字列から string[] に decode。 */
export function parseOptions(j: string | null): string[] {
  if (!j) return [];
  try {
    const a = JSON.parse(j);
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}
