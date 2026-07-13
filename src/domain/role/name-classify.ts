/**
 * 命名規則ベースのロール自動分類 (pure domain, I/O なし・ADR-0009)。
 *
 * Slack 表示名の先頭プレフィックス「(運営)」「(参加者)」等から 4 カテゴリ
 * (参加者 / 運営 / スポンサー / 審査員) へ一次割り当てする純関数群。
 *
 * 安全性 (名簿照合ゲート):
 *   参加者が誤って「(運営)」を名乗る誤爆で運営/スポンサーの機微チャンネルへ
 *   招待する事故を防ぐため、gated カテゴリ (運営/スポンサー) は名簿に名前が
 *   無ければ needsReview フラグを立て、GUI で人が確認するまで確定しない。
 *   参加者カテゴリは厳密チェック不要 (gate 対象外)。
 *
 * 設定として持てる形:
 *   プレフィックス → カテゴリの対応は DEFAULT_PREFIX_RULES を既定に持つが、
 *   classify* 関数は rules を引数で受け取るので action.config 等から差し替え可能。
 */

export type RoleCategory = "participant" | "staff" | "sponsor" | "judge";

/** カテゴリ → 日本語ラベル (UI 表示・ロール名解決に使う)。 */
export const CATEGORY_LABELS: Record<RoleCategory, string> = {
  participant: "参加者",
  staff: "運営",
  sponsor: "スポンサー",
  judge: "審査員",
};

/** プレフィックス文字列 → カテゴリの対応ルール。先頭一致で判定する。 */
export type PrefixRule = { label: string; category: RoleCategory };

/**
 * 既定のプレフィックスルール。長い label を先に置くと部分一致の取りこぼしを
 * 避けられる (現状は重複しないが将来の追加時の指針)。
 */
export const DEFAULT_PREFIX_RULES: readonly PrefixRule[] = [
  { label: "運営", category: "staff" },
  { label: "参加者", category: "participant" },
  { label: "スポンサー", category: "sponsor" },
  { label: "審査員", category: "judge" },
];

/**
 * 名簿照合ゲートが必要なカテゴリ。誤爆で入れると事故になる機微カテゴリのみ。
 * 参加者/審査員のうち gate するのは運営・スポンサーの 2 つ (依頼仕様)。
 */
export const GATED_CATEGORIES: ReadonlySet<RoleCategory> = new Set<RoleCategory>([
  "staff",
  "sponsor",
]);

/**
 * 名簿照合用の名前正規化。NFKC で全角/半角を吸収し、空白除去 + 小文字化する。
 * (whitelist-consensus / role-assign と同方針だが、ここでは空白も畳んで
 *  「山田 太郎」と「山田太郎」を同一視する。)
 */
export function normalizeForMatch(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
}

/**
 * 表示名の先頭にある括弧付きプレフィックスを 1 つ抽出する。
 * 全角/半角の丸括弧・隅付き括弧を許容し、前後の空白を無視する。
 * 例: "（運営）山田" / "(運営) 山田" / "【運営】山田" -> "運営"
 * プレフィックスが無ければ null。
 */
export function extractLeadingBracketLabel(displayName: string): string | null {
  const trimmed = displayName.trim();
  // 括弧: () （） 〔〕 【】 ［］ を許容。中身は 1 文字以上の非括弧。
  const m = trimmed.match(/^[([（〔【［]\s*([^)\]）〕】］]+?)\s*[)\]）〕】］]/);
  if (!m) return null;
  const inner = m[1].trim();
  return inner.length > 0 ? inner : null;
}

export type ClassifyResult = {
  category: RoleCategory | null;
  matchedLabel: string | null;
};

/**
 * 1 つの表示名を分類する。先頭プレフィックスを抽出し、ルールに前方一致
 * (プレフィックス文字列が label で始まる) するカテゴリを返す。該当なしは null。
 */
export function classifyDisplayName(
  displayName: string,
  rules: readonly PrefixRule[] = DEFAULT_PREFIX_RULES,
): ClassifyResult {
  const label = extractLeadingBracketLabel(displayName);
  if (!label) return { category: null, matchedLabel: null };
  const norm = normalizeForMatch(label);
  for (const rule of rules) {
    if (norm.startsWith(normalizeForMatch(rule.label))) {
      return { category: rule.category, matchedLabel: rule.label };
    }
  }
  return { category: null, matchedLabel: null };
}

/** 分類対象メンバーの最小入力。primaryName で分類、matchNames で名簿照合。 */
export type ClassifyMemberInput = {
  id: string;
  /** 分類に使う名前 (通常 Slack display_name)。プレフィックスを含む。 */
  primaryName: string;
  /** 名簿照合に使う名前候補 (display_name / real_name / name 等)。 */
  matchNames: string[];
};

export type MemberClassification = {
  id: string;
  category: RoleCategory | null;
  matchedLabel: string | null;
  /** 名簿 (userId or 名前) に一致したか。 */
  inRoster: boolean;
  /** gated カテゴリなのに名簿に無い = 人の確認が必要。 */
  needsReview: boolean;
};

/**
 * メンバー群を一括分類し、名簿照合ゲートを適用する。
 *
 * @param members       分類対象メンバー
 * @param rosterUserIds 名簿に載っている Slack user id 集合 (最優先の照合キー)
 * @param rosterNames   名簿の名前を normalizeForMatch した集合 (userId 無し行の照合)
 */
export function classifyMembers(
  members: readonly ClassifyMemberInput[],
  rosterUserIds: ReadonlySet<string>,
  rosterNames: ReadonlySet<string>,
  rules: readonly PrefixRule[] = DEFAULT_PREFIX_RULES,
): MemberClassification[] {
  return members.map((m) => {
    const { category, matchedLabel } = classifyDisplayName(m.primaryName, rules);
    const inRoster =
      rosterUserIds.has(m.id) ||
      m.matchNames.some((n) => rosterNames.has(normalizeForMatch(n)));
    // gate 対象カテゴリで名簿に無ければ要確認。gate 外 (参加者/審査員/未分類)
    // は名簿照合を強制しない。
    const needsReview =
      category !== null && GATED_CATEGORIES.has(category) && !inRoster;
    return { id: m.id, category, matchedLabel, inRoster, needsReview };
  });
}

export type ClassificationSummary = {
  total: number;
  byCategory: Record<RoleCategory, number>;
  /** どのプレフィックスにも一致しなかった数。 */
  unclassified: number;
  /** gated カテゴリだが名簿不一致で要確認の数。 */
  needsReview: number;
};

/** 分類結果を件数分布に集計する (個人情報を含まない安全なサマリ)。 */
export function summarizeClassification(
  results: readonly MemberClassification[],
): ClassificationSummary {
  const byCategory: Record<RoleCategory, number> = {
    participant: 0,
    staff: 0,
    sponsor: 0,
    judge: 0,
  };
  let unclassified = 0;
  let needsReview = 0;
  for (const r of results) {
    if (r.category === null) unclassified += 1;
    else byCategory[r.category] += 1;
    if (r.needsReview) needsReview += 1;
  }
  return { total: results.length, byCategory, unclassified, needsReview };
}
