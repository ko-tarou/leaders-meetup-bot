/**
 * ロール名 ⇄ Slack チャンネル名 同期: 命名正規化 (pure domain)。
 *
 * 背景:
 *   HackIT では Slack に「チーム1」..「チーム30」チャンネルがあり、lmb 側にも
 *   同名ロールがある。両者を一致させて運用したい。Slack の
 *   `conversations.rename` は name を命名規則で正規化する:
 *     - 小文字化 (ラテン文字のみ影響。日本語は不変)
 *     - 空白・ピリオドは不可
 *     - 最大 80 文字
 *     - 使用可能: 小文字英字 / 数字 / ハイフン / アンダースコア / 非ラテン文字(日本語可)
 *
 *   よって「チーム1」は空白・大文字・記号を含まないためそのまま通る見込みだが、
 *   「チーム 1」(空白入り) や記号入りロール名は正規化で表示が変わる。UI で
 *   「ロール名 → 実際のチャンネル名」を提示し、崩れる場合は warning を出して
 *   ユーザーに気付かせる (勝手に崩さない・UX を損なわない)。
 *
 * この関数は副作用ゼロの純関数。route (application 層) は Slack/DB の I/O を
 * 集め、この純関数に判断させる。
 */

export type ChannelNameNormalization = {
  /** Slack 命名規則に合わせた確定ターゲット名。 */
  name: string;
  /** 入力 (trim 後のロール名) と最終名が異なる = 表示が変わる場合 true。 */
  changed: boolean;
  /** ユーザーに提示すべき注意 (正規化で崩れた・空になった・切り詰めた等)。 */
  warnings: string[];
};

const MAX_LEN = 80;

/**
 * ロール名を Slack チャンネル名として使える形へ正規化する。
 *
 * - Slack が受け付ける前提の値を返すが、Slack 側でさらに正規化される可能性は
 *   残る (最終確定名は rename レスポンスの channel.name で確認する)。
 * - `changed` は「ロール名そのままではチャンネル名にならない」ことを表し、
 *   UI が「チーム 1 → チーム-1 になります」等の注意を出す判断に使う。
 */
export function normalizeChannelName(roleName: string): ChannelNameNormalization {
  const raw = roleName.trim();
  const warnings: string[] = [];

  // 1) 小文字化 (日本語は不変)。
  let name = raw.toLowerCase();

  // 2) 空白・ピリオドはハイフンへ。
  name = name.replace(/[\s.]+/g, "-");

  // 3) 使用不可文字を除去。許容 = 文字(\p{L}: 日本語含む) / 数字(\p{N}) / _ / -。
  //    ASCII 記号 (! @ # 等) はここで落ちる。
  name = name.replace(/[^\p{L}\p{N}_-]/gu, "");

  // 4) 連続ハイフンを 1 個に畳み、両端のハイフンを除去。
  name = name.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");

  // 5) 長さ上限。
  if (name.length > MAX_LEN) {
    name = name.slice(0, MAX_LEN).replace(/-+$/g, "");
    warnings.push(`80文字を超えるため切り詰めました`);
  }

  const changed = name !== raw;
  if (name.length === 0) {
    warnings.push(
      "正規化後に空になりました。このロール名は Slack チャンネル名に使えません",
    );
  } else if (changed && warnings.length === 0) {
    warnings.push(
      `Slack 命名規則により「${raw}」ではなく「${name}」で作成/リネームされます`,
    );
  }

  return { name, changed, warnings };
}
