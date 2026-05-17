/**
 * DevHub Ops 大規模リファクタ Phase 1-C: D1 Repository seam（最小・パターン確立）。
 *
 * 全 route/service が `drizzle(env.DB)` を直接呼び DI 無しの現状に対し、
 * Phase 1-A/B の provider seam と同型の差し替え可能点を **最小 1 集合**
 * だけ導入してパターンを確立する（全面 Repository 化は後続）。
 *
 * 重要な不変条件（振る舞い不変の根拠）:
 * - メソッドは現状 route で実行している drizzle クエリを **同一クエリ・
 *   同一戻り値・同一順序** でそのまま移植したもの。理想形に作り変えない。
 * - デフォルト実装は呼び出し元から渡された drizzle インスタンスを使い、
 *   現状と完全に同じ SQL を発行する（SELECT 列・WHERE・戻り値の型不変）。
 *   並び替え (submittedAt 降順) と JSON.parse の整形は呼び出し元 route の
 *   責務のまま据え置き、Repository は「DB アクセス」だけを切り出す。
 * - 既存 characterization (participation-api.test.ts) は隔離 D1 上で実
 *   route を叩くため、本 seam を通っても SQL 結果・副作用・エラーは現状と
 *   同一（＝無改変で green を維持）。
 * - 新クエリ追加・WHERE/列変更・schema/migration 変更はしない。
 */
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { participationForms } from "../db/schema";

/** route 側が生成して渡す drizzle インスタンス（schema 無しの素の型）。 */
type Db = ReturnType<typeof drizzle>;

/**
 * participationForms 行。drizzle の `$inferSelect` で schema 定義から
 * select 戻り値型をそのまま導出する（`db.select().from(participationForms)`
 * の戻り要素型と等価。現状 route が扱っていた型と完全一致）。
 */
export type ParticipationFormRow = typeof participationForms.$inferSelect;

/**
 * participation_forms への DB アクセスを抽象化する Repository。
 *
 * 現状 route が直接発行しているクエリと 1:1 で対応する。drizzle
 * インスタンスは呼び出し元から受け取る（env→DB の生成箇所は route の
 * まま据え置き、振る舞い・トランザクション境界を変えない）。
 */
export interface ParticipationFormRepository {
  /**
   * eventId に紐づく全 participationForms 行を返す。
   *
   * 現状の `db.select().from(participationForms)
   *   .where(eq(participationForms.eventId, eventId)).all()` と
   * クエリ・戻り値・順序が完全に一致する（並び替えは呼び出し元の責務）。
   */
  listByEventId(db: Db, eventId: string): Promise<ParticipationFormRow[]>;
}

/**
 * デフォルト実装。現状 route の drizzle クエリをそのまま移植
 * （SELECT 列・WHERE・戻り値・順序すべて現状と同一）。
 */
const defaultParticipationFormRepository: ParticipationFormRepository = {
  listByEventId(db, eventId) {
    // 現状 route と同一クエリ。route が渡す drizzle は schema 無しのため
    // 戻り値が unknown[] に潰れるが、SELECT 列・WHERE は participationForms
    // で固定であり実行結果は schema 付き select と byte-identical。型のみ
    // $inferSelect へ写し取る（現状 route が暗黙に得ていた型と等価・
    // 振る舞い不変）。
    return db
      .select()
      .from(participationForms)
      .where(eq(participationForms.eventId, eventId))
      .all() as Promise<ParticipationFormRow[]>;
  },
};

let participationFormRepository: ParticipationFormRepository =
  defaultParticipationFormRepository;

/**
 * Repository を差し替える（DI seam）。
 * 戻り値で「元の Repository に戻す」復元関数を返すので、テストの
 * afterEach 等で安全に巻き戻せる（Phase 1-A/B と同じ約束）。
 */
export function setParticipationFormRepository(
  repository: ParticipationFormRepository,
): () => void {
  const prev = participationFormRepository;
  participationFormRepository = repository;
  return () => {
    participationFormRepository = prev;
  };
}

/** Repository を初期状態（デフォルト実装）に戻す。 */
export function resetParticipationFormRepository(): void {
  participationFormRepository = defaultParticipationFormRepository;
}

/** 現在の Repository を取得する（DI seam 経由の単一取得点）。 */
export function getParticipationFormRepository(): ParticipationFormRepository {
  return participationFormRepository;
}
