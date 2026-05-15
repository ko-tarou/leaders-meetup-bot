-- participation-form: 参加届フォーム
--
-- 背景:
--   合格した応募者に合格メールと共に送る「参加届フォーム」を新設する。
--   共通 URL /participation/:eventId?t=<token> 方式。token は応募レコードに
--   紐づく不透明トークン。token 無し提出は独立レコード (application_id=NULL)。
--
-- 設計:
--   - applications.participation_token: nullable。合格遷移時にアプリ層で
--     乱数 32byte を発行・格納する。UNIQUE 制約は付けない
--     (SQLite ALTER の制約回避 + 衝突は乱数 32byte で実質排除)。
--     lookup 用に通常 index を張る。
--   - participation_forms: 提出された参加届。event_id は events に FK
--     (ON DELETE CASCADE)。application_id は token 有り提出のとき応募に
--     紐づく FK (ON DELETE SET NULL)、token 無し直接提出は NULL。
--   - token 有りの再提出は upsert で扱うため、application_id が非 NULL の
--     とき重複を防ぐ partial unique index を張る。SQLite は partial index
--     対応。NULL は対象外なので直接提出 (application_id IS NULL) は複数行 OK。
--   - has_allergy は 0/1 の INTEGER boolean。dev_roles は JSON 文字列配列。
--
-- 互換性:
--   participation_token は nullable・DEFAULT NULL なので既存 applications 行は
--   そのまま NULL で残る。participation_forms は新規テーブルなので影響なし。

ALTER TABLE `applications` ADD COLUMN `participation_token` text;
--> statement-breakpoint
CREATE INDEX `idx_applications_participation_token` ON `applications` (`participation_token`);
--> statement-breakpoint
CREATE TABLE `participation_forms` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`application_id` text,
	`name` text NOT NULL,
	`student_id` text,
	`department` text,
	`grade` text,
	`email` text NOT NULL,
	`gender` text,
	`has_allergy` integer DEFAULT 0 NOT NULL,
	`allergy_detail` text,
	`other_affiliations` text,
	`desired_activity` text,
	`dev_roles` text DEFAULT '[]' NOT NULL,
	`submitted_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE CASCADE,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX `idx_participation_forms_event_id` ON `participation_forms` (`event_id`);
--> statement-breakpoint
CREATE INDEX `idx_participation_forms_application_id` ON `participation_forms` (`application_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_participation_forms_app_uniq` ON `participation_forms` (`application_id`) WHERE `application_id` IS NOT NULL;
