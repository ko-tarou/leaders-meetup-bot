/**
 * ロール自動分類の初期ロール構造 (pure domain, I/O なし・ADR-0009)。
 *
 * 4 カテゴリ (参加者/運営/スポンサー/審査員) をルートロールに、運営配下の
 * 詳細ロール (運営統括 / 各チーム / 学年) を子ロールとして持つ既定ツリーを
 * 「仕様」として返す。実際の作成 (DB 反映) は route/service 側が行う。
 *
 * 「設定として編集可能」の担保:
 *   ここで返すのはあくまで**暫定シード**の名前一覧。作成後は通常のロール
 *   CRUD (RolesTab) で追加・改名・削除できる。チーム名や学年が確定したら
 *   GUI で編集する前提で、コードには妥当な初期値だけを置く。
 */

import type { RoleCategory } from "./name-classify";
import { CATEGORY_LABELS } from "./name-classify";

/**
 * 運営配下の詳細ロール (子ロール) の暫定初期値。
 * - 運営統括: 全体を統括する 1 ロール
 * - チーム: 6〜7 チーム想定の暫定 (チームA〜チームF)。GUI で増減・改名可。
 * - 学年: 1〜4 年生の暫定。GUI で調整可。
 * 子ロールのメンバーは親「運営」の部分集合になる (child ⊆ parent invariant)。
 */
export const DEFAULT_STAFF_LEAD = "運営統括";

export const DEFAULT_STAFF_TEAMS: readonly string[] = [
  "チームA",
  "チームB",
  "チームC",
  "チームD",
  "チームE",
  "チームF",
];

export const DEFAULT_GRADES: readonly string[] = [
  "1年生",
  "2年生",
  "3年生",
  "4年生",
];

/** 作成すべき 1 ロールの仕様。parentName が null ならルート。 */
export type SeedRoleSpec = {
  name: string;
  description: string | null;
  /** ルートロールが表すカテゴリ (子ロールは親カテゴリに従うので null)。 */
  category: RoleCategory | null;
  /** 親ロール名。null ならルート。作成時に同 action 内の name で解決する。 */
  parentName: string | null;
};

/**
 * 既定ロールツリーの仕様を返す。
 *   ルート: 参加者 / 運営 / スポンサー / 審査員 (4 カテゴリ)
 *   運営の子: 運営統括 + チーム + 学年
 *
 * 冪等な seed の元データ。route はこの name をキーに「未作成のものだけ」作る。
 */
export function buildDefaultRoleSpecs(opts?: {
  staffLead?: string;
  teams?: readonly string[];
  grades?: readonly string[];
}): SeedRoleSpec[] {
  const staffLead = opts?.staffLead ?? DEFAULT_STAFF_LEAD;
  const teams = opts?.teams ?? DEFAULT_STAFF_TEAMS;
  const grades = opts?.grades ?? DEFAULT_GRADES;

  const staffLabel = CATEGORY_LABELS.staff;
  const specs: SeedRoleSpec[] = [
    {
      name: CATEGORY_LABELS.participant,
      description: "参加者。表示名「(参加者)」で一次割り当て。",
      category: "participant",
      parentName: null,
    },
    {
      name: staffLabel,
      description: "運営。表示名「(運営)」で一次割り当て (名簿照合ゲートあり)。",
      category: "staff",
      parentName: null,
    },
    {
      name: CATEGORY_LABELS.sponsor,
      description: "スポンサー (名簿照合ゲートあり)。",
      category: "sponsor",
      parentName: null,
    },
    {
      name: CATEGORY_LABELS.judge,
      description: "審査員。",
      category: "judge",
      parentName: null,
    },
    // 運営の子ロール。親は名前 (運営) で解決する。
    {
      name: staffLead,
      description: "運営統括。",
      category: null,
      parentName: staffLabel,
    },
    ...teams.map(
      (t): SeedRoleSpec => ({
        name: t,
        description: "運営チーム。",
        category: null,
        parentName: staffLabel,
      }),
    ),
    ...grades.map(
      (g): SeedRoleSpec => ({
        name: g,
        description: "運営の学年区分。",
        category: null,
        parentName: staffLabel,
      }),
    ),
  ];
  return specs;
}
