/**
 * 宗教イベント PR2: whitelist の名前正規化 + 全会一致検出ロジック。
 *
 * - normalizeName: 提出された名前を比較用に正規化する。Unicode NFKC で
 *   全角/半角・互換文字の揺れを吸収し、前後空白を trim、内部の連続空白
 *   (全角空白含む) を半角空白 1 個に畳む。PR4 の全会一致集計はこの正規化済み
 *   文字列をキーに使う (whitelist_unanimous.name_normalized)。
 * - checkConsensus: 全会一致検出 + Slack 通知。PR4 で実装するためここでは
 *   no-op スタブ。シグネチャは PR4 でも不変に保つ (db / eventActionId / env)。
 */
import type { drizzle } from "drizzle-orm/d1";
import type { Env } from "../types/env";

/**
 * 比較用の名前正規化。
 *   1. Unicode NFKC 正規化 (全角英数→半角、互換文字の統一)
 *   2. 前後空白を除去
 *   3. 内部の連続空白 (半角/全角/タブ等あらゆる空白) を半角空白 1 個に畳む
 */
export function normalizeName(raw: string): string {
  return raw
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * 当該 whitelist アクションについて全会一致を再判定し、新規一致を通知する。
 *
 * PR4 で実装する。現状は呼び出し位置 (提出後 hook) を確定させるための no-op。
 * シグネチャ (db, eventActionId, env) は PR4 でも変更しない。
 */
export async function checkConsensus(
  _db: ReturnType<typeof drizzle>,
  _eventActionId: string,
  _env: Env,
): Promise<void> {
  // PR4 で実装
}
