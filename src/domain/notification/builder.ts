/**
 * DevHub Ops 大規模リファクタ Phase 3-2: 通知 builder の pure domain。
 *
 * `src/services/application-notification.ts` /
 * `src/services/participation-notification.ts` の通知送信フローに構造的に
 * 重複していた **純粋な判断/変換ロジック**（副作用ゼロ）をそのまま切り出し
 * 統合したもの。Phase 2-E (`domain/email/template.ts`) で確立した
 * 「pure domain 抽出パターン」を notification context へ統合適用する。
 *
 * 切り出した共通の純粋ロジック:
 *  - generic config の parse（任意キーで `parsed[configKey]` を取り出す）
 *  - enabled/workspace/channel ガードの判定（送信可否＝設定の妥当性のみ）
 *  - mention prefix の構築（`<@U...>` 連結。空配列なら空文字）
 *  - テンプレ選択（messageTemplate?.trim() ? messageTemplate : default）
 *  - 最終テキスト構築（renderTemplate 適用後 .trim()）
 *
 * 重要な不変条件（振る舞い不変の根拠）:
 * - 各関数は現状 service のコードを **式・順序・戻り値・イディオムを変えず**
 *   に移植した。mention の filter 条件・join セパレータ・テンプレ選択の
 *   trim 判定・renderTemplate 適用後の .trim() は byte-identical
 *   （characterization application-notification / participation-notification
 *   が無改変 green であることが機械的証明）。
 * - domain は純粋関数のみ。env / db / fetch / Slack postMessage / 時刻取得
 *   など I/O を一切持たない。config の JSON.parse は副作用ゼロの純粋変換
 *   のため domain に置く（Slack 送信・workspace 解決・fail-soft try/catch
 *   は service 境界に残す）。
 * - vars 構築は domain 固有（appliedAt の JST 変換等、service が時刻取得を
 *   担う）なので service 側に残し、本 builder は組み上がった vars を受け取る
 *   形で generic に保つ（application/participation 双方が使える）。
 */

import { renderTemplate } from "../email/template";

/**
 * application / participation 共通の通知設定の generic 形。
 * service 側の ApplicationNotificationConfig /
 * ParticipationNotificationConfig はこの構造の別名（互換維持）。
 */
export type NotificationConfig = {
  enabled?: boolean;
  workspaceId?: string;
  channelId?: string;
  mentionUserIds?: string[];
  /** 未設定 or 空文字なら default テンプレを使う。 */
  messageTemplate?: string;
};

/**
 * action.config を parse して指定キーの通知設定を取り出す。
 * 不正な JSON / 欠損は undefined を返す (= 通知無効扱い)。
 *
 * 現状の readNotificationsConfig (`parsed.notifications`) /
 * readParticipationNotificationConfigByKey (`parsed[configKey]`) を
 * configKey 引数で generic 化したもの。挙動不変。
 */
export function readNotificationConfigByKey(
  rawConfig: string | null | undefined,
  configKey: string,
): NotificationConfig | undefined {
  if (!rawConfig) return undefined;
  try {
    const parsed = JSON.parse(rawConfig) as Record<
      string,
      NotificationConfig | undefined
    >;
    return parsed[configKey];
  } catch {
    return undefined;
  }
}

/**
 * 送信可否（= 設定の妥当性）の判定。
 * enabled でない / workspace / channel が空 なら false。
 * 現状 service の `if (!notif?.enabled) return; if (!notif.workspaceId ||
 * !notif.channelId) return;` ガードと同値（純粋判定のみ。I/O 不在）。
 */
export function isNotificationSendable(
  notif: NotificationConfig | undefined,
): notif is NotificationConfig & { workspaceId: string; channelId: string } {
  if (!notif?.enabled) return false;
  if (!notif.workspaceId || !notif.channelId) return false;
  return true;
}

/**
 * mention prefix を構築する。
 * mentionUserIds から非空文字列のみ残し `<@U...>` 形式でスペース連結する。
 * 空配列なら空文字。現状 service の mentionPrefix 構築と byte-identical。
 */
export function buildMentionPrefix(
  mentionUserIds: string[] | undefined,
): string {
  const mentionIds = Array.isArray(mentionUserIds)
    ? mentionUserIds.filter((u) => typeof u === "string" && u.length > 0)
    : [];
  return mentionIds.map((u) => `<@${u}>`).join(" ");
}

/**
 * 送信する最終テキストを構築する。
 * messageTemplate?.trim() が truthy ならそれを、さもなくば defaultTemplate を
 * renderTemplate(template, vars) に通し、結果を .trim() する。
 * 現状 service の template 選択 + renderTemplate(...).trim() と byte-identical。
 */
export function buildNotificationText(
  messageTemplate: string | undefined,
  defaultTemplate: string,
  vars: Record<string, string>,
): string {
  const template = messageTemplate?.trim() ? messageTemplate : defaultTemplate;
  return renderTemplate(template, vars).trim();
}
