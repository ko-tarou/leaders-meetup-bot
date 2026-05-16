/**
 * 006-0-1: テスト用 D1 ハーネス。
 *
 * `migrations/*.sql` を **ファイル名昇順** (= 連番順、wrangler の
 * `d1 migrations apply` と同じ順序) で読み込み、`--> statement-breakpoint`
 * 区切りで分割した各ステートメントを miniflare の使い捨て D1 に適用する。
 *
 * 重要 (本番 D1 非接触の保証):
 * - 適用先は vitest.config.ts の miniflare `d1Databases.DB` (プロセス内 SQLite)。
 *   wrangler.toml の `database_id` 本番 D1 には一切接続しない。
 * - SQL は Vite の `import.meta.glob(..., '?raw')` でビルド時にインライン化する。
 *   Workers ランタイム内では Node `fs` が使えないため、この方式で全 migration を
 *   バンドルに含める。
 * - `_journal.json` ではなくファイル名順で **全 46 SQL** を適用する
 *   (0028 / 0043〜0047 は journal 未登録だが本番に存在する実 migration のため、
 *    schema を完全再現するにはファイル名順での全適用が正)。
 */

// eager: false で各 SQL を ?raw 文字列として取得する。キーは
// "/migrations/0000_dusty_falcon.sql" のような絶対 (project root 相対) パス。
const migrationModules = import.meta.glob("/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** ファイル名 (連番プレフィックス) 昇順にソートした [path, sql] の一覧。 */
function sortedMigrations(): Array<[string, string]> {
  return Object.entries(migrationModules).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
}

/**
 * 1 ステートメントから行頭 `--` コメント行と空行を除去する。
 *
 * D1 の `exec` はコメント行のみだと "did not contain a statement" を出す。
 * drizzle-kit の migration はステートメント冒頭に `-- 説明` を置くことが
 * あるため、コメント行を落としてから実行する (SQL 本体は保持)。
 */
function stripSqlComments(stmt: string): string {
  return stmt
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return t.length > 0 && !t.startsWith("--");
    })
    .join("\n")
    .trim();
}

/**
 * SQL ファイル本文を `--> statement-breakpoint` で分割し、コメント除去後に
 * 空でないステートメントの配列を返す。drizzle-kit が生成する breakpoint
 * 規約に従う。
 */
export function splitStatements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((s) => stripSqlComments(s))
    .filter((s) => s.length > 0);
}

/** 適用対象 migration のファイル名一覧 (順序付き)。検証・ログ用。 */
export function migrationFileNames(): string[] {
  return sortedMigrations().map(([path]) =>
    path.replace(/^.*\//, "").replace(/\.sql$/, ""),
  );
}

/**
 * 渡された D1 binding に全 migration をファイル名昇順で適用する。
 * 各ステートメントを個別に exec する (D1 の exec は単一文ずつが安全)。
 */
export async function applyMigrations(db: D1Database): Promise<void> {
  for (const [path, sql] of sortedMigrations()) {
    const statements = splitStatements(sql);
    for (const stmt of statements) {
      try {
        // D1 の `exec` は行単位で分割するため複数行 DDL を壊す。
        // `prepare().run()` は 1 ステートメントを丸ごと実行できるので
        // こちらを使う (CREATE TABLE 等の複数行 SQL を保持)。
        await db.prepare(stmt).run();
      } catch (e) {
        throw new Error(
          `migration failed at ${path}: ${(e as Error).message}\n--- stmt ---\n${stmt}`,
        );
      }
    }
  }
}
