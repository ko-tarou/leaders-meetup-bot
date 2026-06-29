// PR レビュアー自動割当の純粋ドメイン (I/O なし・テスト容易)。
//
// 役割:
//   1. PR の「ドメイン (職能)」を判定する (detectDiscipline)。
//   2. 職能ごとの近接補完マップ (ADJACENCY) を定義する。
//   3. 主職能 → 近接職能 → 残り、の順にメンバーを集めて重複/作者を除き
//      最大 N 人 (既定 3) のレビュアーを選ぶ (selectReviewers)。
//
// メンバーは Slack user_id (slack_role_members) をそのまま扱う。GitHub→Slack
// の逆引きが無くても動くよう、レビュアー候補は職能ロールのメンバーから直接取る。

/** 職能ロール名。slack_roles.name と一字一句一致させる (D1 lookup の key)。 */
export const DISCIPLINES = [
  "PM",
  "Android",
  "iOS",
  "フロントエンド",
  "バックエンド",
  "インフラ",
] as const;
export type Discipline = (typeof DISCIPLINES)[number];

/**
 * 近接補完マップ: 主職能の担当が少ない時に補完する隣接分野。
 * 例: フロント担当が 1 人なら バックエンド から補う / Android <-> iOS。
 * 順序は補完優先度 (先頭ほど近い)。
 */
export const ADJACENCY: Record<Discipline, Discipline[]> = {
  フロントエンド: ["バックエンド", "PM"],
  バックエンド: ["フロントエンド", "インフラ"],
  インフラ: ["バックエンド", "PM"],
  Android: ["iOS", "バックエンド"],
  iOS: ["Android", "バックエンド"],
  // PM は横断職能なので開発系全般から補完する。
  PM: ["バックエンド", "フロントエンド"],
};

/** ラベル/リポ名のキーワード -> 職能。先頭一致が優先。 */
const KEYWORD_RULES: Array<{ discipline: Discipline; patterns: RegExp }> = [
  { discipline: "Android", patterns: /android|kotlin|\bapk\b/i },
  { discipline: "iOS", patterns: /\bios\b|swift|xcode/i },
  {
    discipline: "フロントエンド",
    patterns: /front|frontend|web|react|next|vue|\bui\b|\bcss\b/i,
  },
  {
    discipline: "インフラ",
    patterns: /infra|terraform|\bops\b|\bci\b|\bcd\b|docker|deploy|sre|cloudflare|wrangler/i,
  },
  {
    discipline: "バックエンド",
    patterns: /back|backend|\bapi\b|server|\bdb\b|database|migration/i,
  },
  { discipline: "PM", patterns: /\bpm\b|project|manage|管理|企画/i },
];

export type DetectInput = {
  /** "owner/repo"。 */
  repo: string;
  /** PR ラベル名 (任意)。最も具体的な人手シグナルとして最優先。 */
  labels?: string[];
  /** "owner/repo" -> 職能 の明示マップ (admin 設定・任意)。 */
  repoDisciplineMap?: Record<string, string>;
};

function matchKeyword(text: string): Discipline | null {
  for (const rule of KEYWORD_RULES) {
    if (rule.patterns.test(text)) return rule.discipline;
  }
  return null;
}

function asDiscipline(v: string | undefined | null): Discipline | null {
  return v != null && (DISCIPLINES as readonly string[]).includes(v)
    ? (v as Discipline)
    : null;
}

/**
 * PR のドメイン (職能) を判定する。優先順位:
 *   1. ラベル (per-PR の明示シグナル)
 *   2. repoDisciplineMap[repo] (admin の明示設定)
 *   3. リポ名のキーワード推定
 *   4. 既定 "PM" (横断職能・担当不在を防ぐ最終フォールバック)
 */
export function detectDiscipline(input: DetectInput): Discipline {
  for (const label of input.labels ?? []) {
    const d = matchKeyword(label);
    if (d) return d;
  }
  const mapped = asDiscipline(input.repoDisciplineMap?.[input.repo]);
  if (mapped) return mapped;

  const repoName = input.repo.split("/").pop() ?? input.repo;
  const byRepo = matchKeyword(repoName);
  if (byRepo) return byRepo;

  return "PM";
}

/** 主職能の探索順 (主 -> 近接 -> 残りの職能)。重複は先勝ちで除く。 */
export function disciplineSearchOrder(primary: Discipline): Discipline[] {
  const order: Discipline[] = [primary, ...(ADJACENCY[primary] ?? [])];
  for (const d of DISCIPLINES) if (!order.includes(d)) order.push(d);
  return order;
}

export type SelectReviewersInput = {
  primary: Discipline;
  /** 職能 -> その職能ロールのメンバー (Slack user_id)。 */
  membersByDiscipline: Partial<Record<Discipline, string[]>>;
  /** 除外する Slack user_id (PR 作者など)。 */
  exclude?: string[];
  /** 集めるレビュアー上限。既定 3。 */
  limit?: number;
};

export type SelectReviewersResult = {
  /** 選ばれたレビュアー (Slack user_id)。最大 limit 人。 */
  slackUserIds: string[];
  /** 近接補完 (主職能以外) から補ったか。 */
  usedFallback: boolean;
};

/**
 * 主職能 -> 近接職能 -> 残り、の順にメンバーを集め、重複と exclude を除いて
 * 最大 limit 人のレビュアーを選ぶ。担当が 1 人しか居ない分野でも近接分野から
 * 補完されるため「レビュー依頼は 3 人」を満たしやすい。
 */
export function selectReviewers(
  input: SelectReviewersInput,
): SelectReviewersResult {
  const limit = input.limit ?? 3;
  const excludeSet = new Set(input.exclude ?? []);
  const order = disciplineSearchOrder(input.primary);

  const picked: string[] = [];
  const seen = new Set<string>();
  let usedFallback = false;

  for (const discipline of order) {
    if (picked.length >= limit) break;
    const members = input.membersByDiscipline[discipline] ?? [];
    for (const id of members) {
      if (picked.length >= limit) break;
      if (seen.has(id) || excludeSet.has(id)) continue;
      seen.add(id);
      picked.push(id);
      if (discipline !== input.primary) usedFallback = true;
    }
  }

  return { slackUserIds: picked, usedFallback };
}
