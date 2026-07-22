-- One-off production data fix (idempotent; already applied to remote D1 on 2026-07-22).
-- Purpose: カンファ本部チームのガント見出し是正。
--   ガントChartTabのグループ見出しは子タスク title のコロン前接頭辞から導出される
--   (deriveGroupLabel)。本部タスクの title は "本部: <内容>" で全て同じ接頭辞だったため
--   見出しが「本部」だけになり、接頭辞が混在するグループは「工程 X.Y」にフォールバックしていた。
--   会計チーム(既存)と同じく接頭辞を「工程系統名」に統一し、意味の分かる見出しにする。
-- Scope: team='本部' の tasks.title のみ更新 (58件)。行削除・event_id・wbs・依存関係は不変。
--   他チーム(会計/集客告知/全体進行/会場/開発/スポンサー 等)には一切触れない。
-- Event: acd75449-c875-4c13-83d8-2dd8f8ce8a33 / Gantt action: 530062f3-995a-4f9b-9fdd-17f3c965e773
-- Re-apply: npx wrangler d1 execute leaders-meetup-bot --remote --file <this file>

UPDATE tasks SET title='法人設立・外部窓口: 発起人・機関設計の意思決定（代表/取締役/出資者 確定）', updated_at=datetime('now') WHERE id='41186bb0-1dd7-4524-8b88-12c7a3c88d4b' AND team='本部';
UPDATE tasks SET title='法人設立・外部窓口: 学校（学生課/産学連携）への設立・活動報告 窓口一元化', updated_at=datetime('now') WHERE id='65ac0dee-561c-43a7-b89d-674f49a5cbe2' AND team='本部';
UPDATE tasks SET title='リーダー打診・キックオフ: リーダー候補5名 個別打診 (第1陣)', updated_at=datetime('now') WHERE id='6585f153-46a3-4ae4-b7d6-22be6c096a44' AND team='本部';
UPDATE tasks SET title='リーダー打診・キックオフ: カンファ運営 キックオフMTG (マイルストーン)', updated_at=datetime('now') WHERE id='5654b1c9-30f8-45e7-8d40-7f4721335440' AND team='本部';
UPDATE tasks SET title='リーダー打診・キックオフ: 運営コアメンバー確定・役割仮アサイン', updated_at=datetime('now') WHERE id='307d402e-714f-4535-a70f-4b558dfd66cb' AND team='本部';
UPDATE tasks SET title='リーダー打診・キックオフ: キックオフ後の運営全体会議 定例化（意思決定の場）', updated_at=datetime('now') WHERE id='5ecc57b2-070e-4cf4-9d8e-7ff768fb3c7c' AND team='本部';
UPDATE tasks SET title='会議体・意思決定設計: 会議体設計（全体会議/コア会議/リーダー会 の目的・頻度・参加者）', updated_at=datetime('now') WHERE id='7a8fe0ae-b583-4ca3-8127-70f9c00c6778' AND team='本部';
UPDATE tasks SET title='会議体・意思決定設計: アジェンダ/議事録/意思決定ログ テンプレ整備・運用開始', updated_at=datetime('now') WHERE id='b9693a12-90f0-4f4e-acf7-f713053ec83e' AND team='本部';
UPDATE tasks SET title='会議体・意思決定設計: 意思決定フロー策定（誰が何を決める・エスカレーション経路）', updated_at=datetime('now') WHERE id='2bd40d14-008a-42c2-9a4d-d878fc42ed43' AND team='本部';
UPDATE tasks SET title='組織設計・RACI: 運営組織図 作成（チーム構成・レポートライン）', updated_at=datetime('now') WHERE id='3933b189-9449-40fc-be80-17aa7132711f' AND team='本部';
UPDATE tasks SET title='組織設計・RACI: 役割分担・責任分界表(RACI) 作成', updated_at=datetime('now') WHERE id='79cb7552-c7a4-4eca-946d-38a13a164894' AND team='本部';
UPDATE tasks SET title='組織設計・RACI: メンバーアサイン表 整備・各チームリーダー確定', updated_at=datetime('now') WHERE id='5f60a668-347e-462d-b560-410fb7f9f41c' AND team='本部';
UPDATE tasks SET title='ドキュメント基盤: 共有ドライブ構成設計（フォルダ体系・命名規則）', updated_at=datetime('now') WHERE id='572fd3a2-e450-49cb-8744-f5d8e27a234c' AND team='本部';
UPDATE tasks SET title='ドキュメント基盤: アクセス権/権限ポリシー策定・付与運用', updated_at=datetime('now') WHERE id='5b41dabc-d620-4f11-852d-bb6faf42c707' AND team='本部';
UPDATE tasks SET title='ドキュメント基盤: ナレッジ管理ルール周知（保存場所・更新責任）', updated_at=datetime('now') WHERE id='e4b26c41-7c64-4679-a20d-97262d0222f5' AND team='本部';
UPDATE tasks SET title='規約・行動規範ドラフト: 運営規約/内部ルール ドラフト作成', updated_at=datetime('now') WHERE id='2fcbebeb-2ab8-462b-8970-7fc563cc8e73' AND team='本部';
UPDATE tasks SET title='規約・行動規範ドラフト: 行動規範（運営メンバー向けCoC）ドラフト作成', updated_at=datetime('now') WHERE id='d73e3283-89fa-4d17-981a-ef060f9ec50a' AND team='本部';
UPDATE tasks SET title='コア30体制確立: 6チーム体制確立 コア30人 (マイルストーン)', updated_at=datetime('now') WHERE id='56d90336-42fc-4570-b5b8-9df1e514c9f8' AND team='本部';
UPDATE tasks SET title='コア30体制確立: 6チーム リーダー/サブリーダー アサイン確定', updated_at=datetime('now') WHERE id='4033efc9-4c89-4aae-a3a7-abecaf22ff39' AND team='本部';
UPDATE tasks SET title='コア30体制確立: チーム間連携ルール・情報共有会 設計', updated_at=datetime('now') WHERE id='6dbbcc6d-9e64-4c5c-95bf-8d31979ee069' AND team='本部';
UPDATE tasks SET title='スケジュール統括: マスタースケジュール整備（全チーム統合・マイルストーン）', updated_at=datetime('now') WHERE id='d5baecc8-25ab-4d63-a80d-95f847a4a8e8' AND team='本部';
UPDATE tasks SET title='スケジュール統括: 逆算工程表の全チーム展開・依存関係整理', updated_at=datetime('now') WHERE id='9819e666-cb27-4330-a57d-16827e5b0d60' AND team='本部';
UPDATE tasks SET title='スケジュール統括: 進捗集約の仕組み運用（各チーム報告→本部集約→ガント更新）', updated_at=datetime('now') WHERE id='f9bb2da1-0f6d-4c66-94a6-9f0ac30163ca' AND team='本部';
UPDATE tasks SET title='リスク・危機管理: リスク洗い出し・リスク登録簿 作成', updated_at=datetime('now') WHERE id='5817e2e6-8d2f-423f-ae74-f74253e04ca4' AND team='本部';
UPDATE tasks SET title='リスク・危機管理: リスク対応計画（軽減策・発生時対応）策定', updated_at=datetime('now') WHERE id='fa02f4ad-434b-4418-8e8f-4db2e9d2e094' AND team='本部';
UPDATE tasks SET title='リスク・危機管理: 緊急時対応フロー・連絡網 初版作成', updated_at=datetime('now') WHERE id='8ef31a2b-7496-44cb-aa83-79e9d36c2cea' AND team='本部';
UPDATE tasks SET title='予備費承認フロー: 予備費・緊急支出の承認フロー策定（会計連携・承認は本部）', updated_at=datetime('now') WHERE id='03c83b78-a7b4-4116-8fb2-3447c4461d68' AND team='本部';
UPDATE tasks SET title='外部折衝・渉外: 学校（学生課/産学連携）定期報告・渉外の窓口運用', updated_at=datetime('now') WHERE id='0b2ad1e4-da86-47b6-b62c-9074be0ff9cc' AND team='本部';
UPDATE tasks SET title='外部折衝・渉外: 外部団体/協力者との折衝統括（窓口一元化ルール）', updated_at=datetime('now') WHERE id='91189fdd-f3d8-4285-81d2-b5be7a7e934e' AND team='本部';
UPDATE tasks SET title='体制移行ガバナンス: 8チーム移行に伴う組織図/RACI 改訂', updated_at=datetime('now') WHERE id='f29fec29-525d-40d9-81d7-36224d471252' AND team='本部';
UPDATE tasks SET title='体制移行ガバナンス: 移行時の役割再アサイン・引き継ぎ整理', updated_at=datetime('now') WHERE id='6145f293-8725-47db-b549-467b6f19bd70' AND team='本部';
UPDATE tasks SET title='コア50・班長任命: 班長層 充足・コア50人へ増員', updated_at=datetime('now') WHERE id='62bdf5bd-cf6e-4a4a-9c79-53c5a32a7079' AND team='本部';
UPDATE tasks SET title='コア50・班長任命: コア50人 完成 (マイルストーン)', updated_at=datetime('now') WHERE id='8a69d16c-486f-4dd4-bc33-2a07f1c1ab5e' AND team='本部';
UPDATE tasks SET title='勧誘・ボランティア募集: 新入生勧誘 (2027新入生の取り込み)', updated_at=datetime('now') WHERE id='48c327c1-aa9f-4984-8430-eeeb9a659c41' AND team='本部';
UPDATE tasks SET title='勧誘・ボランティア募集: 当日ボランティア250人 募集', updated_at=datetime('now') WHERE id='521c9aa1-3dcb-4825-a1d0-7668c0dd5ecd' AND team='本部';
UPDATE tasks SET title='各種規約確定: 参加者向け行動規範(Code of Conduct) 確定・公開版', updated_at=datetime('now') WHERE id='9ba99b88-ee42-4eb4-8e64-e68642224edc' AND team='本部';
UPDATE tasks SET title='各種規約確定: 個人情報/プライバシー方針・データ管理ルール 確定', updated_at=datetime('now') WHERE id='65d3367c-f5f8-4103-ac62-8e61ec747f95' AND team='本部';
UPDATE tasks SET title='各種規約確定: 肖像権・撮影/録画 同意方針 策定', updated_at=datetime('now') WHERE id='8d2bc73d-7d24-472e-a10b-3157017994b6' AND team='本部';
UPDATE tasks SET title='各種規約確定: 運営規約/内部ルール 確定版', updated_at=datetime('now') WHERE id='96882997-cf50-4b8a-80c1-8af006afef18' AND team='本部';
UPDATE tasks SET title='保険・安全・防災・救護: イベント保険（賠償責任等）比較・加入', updated_at=datetime('now') WHERE id='7d7d6912-cd87-467b-b940-6e653b36ea12' AND team='本部';
UPDATE tasks SET title='保険・安全・防災・救護: 安全/防災計画（避難経路・防災体制）策定', updated_at=datetime('now') WHERE id='a11f114e-30b3-4894-acc9-17f4edc2c39b' AND team='本部';
UPDATE tasks SET title='保険・安全・防災・救護: 救護体制（救護所/AED/救急連絡）設計', updated_at=datetime('now') WHERE id='42693ef9-49d2-4131-8be3-0ab6de8ef6d2' AND team='本部';
UPDATE tasks SET title='当日運営体制設計: 当日運営体制図・本部席の役割定義', updated_at=datetime('now') WHERE id='c28d23c7-ed32-44db-8548-9757a2b895b4' AND team='本部';
UPDATE tasks SET title='当日運営体制設計: シフト/人員配置 統括方針（各チーム連携）', updated_at=datetime('now') WHERE id='66e7e229-3558-4e12-a8ac-e047c48edf2a' AND team='本部';
UPDATE tasks SET title='当日運営体制設計: 当日連絡網・指揮系統（トランシーバ/チャット運用）確定', updated_at=datetime('now') WHERE id='4c4c75b1-226c-4ecc-8f15-535493b0f10f' AND team='本部';
UPDATE tasks SET title='当日運営体制設計: トラブル対応マニュアル（想定インシデント別対応）作成', updated_at=datetime('now') WHERE id='eb2977d9-4984-48b2-9e25-1836706e9489' AND team='本部';
UPDATE tasks SET title='参加者対応方針: 参加者/来場者対応方針（受付/誘導/問い合わせ 方針決定）', updated_at=datetime('now') WHERE id='500e562e-3b1f-48a5-80f3-9490dfc9a6e1' AND team='本部';
UPDATE tasks SET title='参加者対応方針: 緊急時の参加者アナウンス・避難誘導 方針策定', updated_at=datetime('now') WHERE id='fc824562-4450-48bf-947e-afbf4cd375ee' AND team='本部';
UPDATE tasks SET title='当日統括: カンファ本番 Day1-2 (マイルストーン)', updated_at=datetime('now') WHERE id='97f149dc-8f9a-484c-a7fa-7aba33d720c9' AND team='本部';
UPDATE tasks SET title='当日統括: 当日 本部席運営・司令塔（全体統括・意思決定）', updated_at=datetime('now') WHERE id='dec9b584-c583-4e14-b8e4-a2ad0aed1236' AND team='本部';
UPDATE tasks SET title='当日統括: 当日 タイムキープ統括・進行監督', updated_at=datetime('now') WHERE id='9a4a26b7-fa9c-432d-993f-3caa75e58179' AND team='本部';
UPDATE tasks SET title='当日統括: 当日 トラブル対応・危機対応 指揮', updated_at=datetime('now') WHERE id='736aba68-255a-4535-b103-0db25de3a90a' AND team='本部';
UPDATE tasks SET title='当日統括: 当日 シフト/人員配置の運用・欠員対応', updated_at=datetime('now') WHERE id='f8b8ba9d-6926-4c81-ac65-5ed0a05c5e0b' AND team='本部';
UPDATE tasks SET title='当日統括: 前日 最終ブリーフィング・全チーム最終確認', updated_at=datetime('now') WHERE id='e8a7dfdb-9c11-4543-8a36-ecefb47a5a77' AND team='本部';
UPDATE tasks SET title='事後処理・振り返り: 撤収・原状回復の統括確認', updated_at=datetime('now') WHERE id='5cd08e78-19a8-4409-8840-b2d15898260d' AND team='本部';
UPDATE tasks SET title='事後処理・振り返り: 振り返り（KPT/反省会）開催', updated_at=datetime('now') WHERE id='c5eeae75-981d-4ae8-8440-b37d61f8f117' AND team='本部';
UPDATE tasks SET title='事後処理・振り返り: 開催報告書・成果報告 作成', updated_at=datetime('now') WHERE id='78550a16-fd33-467e-9489-34044dc35ec5' AND team='本部';
UPDATE tasks SET title='事後処理・振り返り: 次年度への引き継ぎ資料・ナレッジ整理', updated_at=datetime('now') WHERE id='3468555d-865c-4aac-9eb7-0aae33ff530c' AND team='本部';
