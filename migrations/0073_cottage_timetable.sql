-- コテージ旅行タイムテーブル (cottage_timetable) の作成 + 初期 seed。
--
-- 背景: cottage-ios アプリの予定をバックエンド駆動にする。瀬女コテージ (2026-08-06〜07・
--   1泊2日) のタイムテーブルを 1 ドキュメントとして保持し、公開 GET /api/cottage/timetable
--   で配信する。data は { trip, days } を JSON 文字列で保持する単一行 (id='cottage')。
--
-- 後方互換: 新規テーブルの追加のみ。既存 event_actions / events には一切触れない。
--   seed は INSERT OR IGNORE なので再適用しても既存行を壊さない。
--
-- seed 内容: iOS 側 Cottage/Data/SampleData.swift の schedule と整合させた Day1/Day2。

CREATE TABLE `cottage_timetable` (
	`id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO `cottage_timetable` (`id`, `data`, `updated_at`) VALUES ('cottage', '{"trip":{"title":"瀬女コテージ","startDate":"2026-08-06","endDate":"2026-08-07"},"days":[{"day":1,"date":"2026-08-06","items":[{"id":"d1-1","start":"14:00","end":"15:00","title":"集合・出発／食材集め","location":"金沢","note":"男性班は出発、各組はスーパーで食材の買い物。"},{"id":"d1-2","start":"15:00","end":"16:00","title":"移動（瀬女コテージ村へ）","location":"","note":""},{"id":"d1-3","start":"16:00","end":"16:40","title":"瀬女コテージ村 到着・チェックイン","location":"瀬女コテージ村","note":""},{"id":"d1-4","start":"16:40","end":"17:20","title":"スイカ割り・BBQ準備（男性班）","location":"瀬女コテージ村 広場","note":"スイカ組がスイカ割り、BBQ組はBBQ準備を並行。"},{"id":"d1-5","start":"16:40","end":"18:00","title":"川釣り（女性・釣り組）","location":"吉野観光 管理釣り場（車15分）","note":"営業〜18:00。18:00にコテージで合流。"},{"id":"d1-6","start":"17:20","end":"18:00","title":"BBQ準備（全体）","location":"瀬女コテージ村 BBQ場","note":""},{"id":"d1-7","start":"18:00","end":"20:30","title":"BBQ（夕食）","location":"瀬女コテージ村 BBQ場","note":"釣り組は18:00合流、19:00からBBQ。"},{"id":"d1-8","start":"20:30","end":"21:00","title":"BBQ片付け","location":"瀬女コテージ村 BBQ場","note":""},{"id":"d1-9","start":"21:00","end":"22:00","title":"宝探し","location":"瀬女コテージ村 広場","note":"夜の広場で宝探し。"},{"id":"d1-10","start":"22:00","end":"23:00","title":"夜食（パスタ・マシュマロ）","location":"","note":""},{"id":"d1-11","start":"23:00","end":"23:30","title":"天体観測","location":"瀬女コテージ村 周辺","note":"ブルーシートを敷いて星空観賞。"},{"id":"d1-12","start":"23:30","end":"24:00","title":"親睦タイム（男女別）","location":"","note":"男性飲み・女性飲み。"}]},{"day":2,"date":"2026-08-07","items":[{"id":"d2-1","start":"08:00","end":"09:30","title":"起床・準備","location":"瀬女コテージ村","note":""},{"id":"d2-2","start":"09:30","end":"11:00","title":"朝食（フレンチトースト）","location":"瀬女コテージ村","note":""},{"id":"d2-3","start":"11:00","end":"12:00","title":"荷造り・片付け","location":"瀬女コテージ村","note":""},{"id":"d2-4","start":"12:00","end":"12:30","title":"チェックアウト・解散・帰路","location":"瀬女コテージ村","note":"最終時刻は要確定。"}]}]}', '2026-06-30T12:00:00Z');
