-- 流しそうめんギネス (event e68a1a28...) のガント見出し是正:
-- グループ (同一チーム×WBS親) のタスク title に共通の「工程系統名: 」接頭辞を付け、
-- ガントのグループ見出しが WBS 番号(工程 X.Y)でなく意味の分かる工程名になるようにする。
-- 各グループのメンバー全員に同一接頭辞を付ける (deriveGroupLabel が共通接頭辞を見出しにする)。

-- 1.1 竹材の確保
UPDATE tasks SET title='竹材の確保: '||title WHERE event_id='e68a1a28-5213-4d6a-9ef2-36f1dd4df9b3' AND wbs IN ('1.1.1','1.1.2','1.1.3');
-- 1.2 食材・道具の調達
UPDATE tasks SET title='食材・道具の調達: '||title WHERE event_id='e68a1a28-5213-4d6a-9ef2-36f1dd4df9b3' AND wbs IN ('1.2.1','1.2.2','1.2.3');
-- 1.3 衛生・保健所対応
UPDATE tasks SET title='衛生・保健所対応: '||title WHERE event_id='e68a1a28-5213-4d6a-9ef2-36f1dd4df9b3' AND wbs IN ('1.3.1','1.3.2','1.3.3');
-- 1.4 運営・予算準備
UPDATE tasks SET title='運営・予算準備: '||title WHERE event_id='e68a1a28-5213-4d6a-9ef2-36f1dd4df9b3' AND wbs IN ('1.4.1','1.4.2','1.4.3','1.4.4');
-- 1.5 クラファン(100m)
UPDATE tasks SET title='クラファン(100m): '||title WHERE event_id='e68a1a28-5213-4d6a-9ef2-36f1dd4df9b3' AND wbs IN ('1.5.1','1.5.2','1.5.3','1.5.4','1.5.5');
-- 2.1 当日運営(100mデモ)
UPDATE tasks SET title='当日運営(100mデモ): '||title WHERE event_id='e68a1a28-5213-4d6a-9ef2-36f1dd4df9b3' AND wbs IN ('2.1.1','2.1.2','2.1.3');
-- 3.1 路線選定・地権者調整
UPDATE tasks SET title='路線選定・地権者調整: '||title WHERE event_id='e68a1a28-5213-4d6a-9ef2-36f1dd4df9b3' AND wbs IN ('3.1.1','3.1.2');
-- 3.2 許認可申請(5km)
UPDATE tasks SET title='許認可申請(5km): '||title WHERE event_id='e68a1a28-5213-4d6a-9ef2-36f1dd4df9b3' AND wbs IN ('3.2.1','3.2.2','3.2.3');
-- 3.3 ギネス方針決定
UPDATE tasks SET title='ギネス方針決定: '||title WHERE event_id='e68a1a28-5213-4d6a-9ef2-36f1dd4df9b3' AND wbs IN ('3.3.1','3.3.2');
-- 4.1 スポンサー開拓
UPDATE tasks SET title='スポンサー開拓: '||title WHERE event_id='e68a1a28-5213-4d6a-9ef2-36f1dd4df9b3' AND wbs IN ('4.1.1','4.1.2','4.1.3','4.1.4');
-- 4.2 クラファン(5km)
UPDATE tasks SET title='クラファン(5km): '||title WHERE event_id='e68a1a28-5213-4d6a-9ef2-36f1dd4df9b3' AND wbs IN ('4.2.1','4.2.2','4.2.3','4.2.4');
-- 5.2 水源確保(5km)
UPDATE tasks SET title='水源確保(5km): '||title WHERE event_id='e68a1a28-5213-4d6a-9ef2-36f1dd4df9b3' AND wbs IN ('5.2.1','5.2.2');
-- 6.1 当日運営(5km本番)
UPDATE tasks SET title='当日運営(5km本番): '||title WHERE event_id='e68a1a28-5213-4d6a-9ef2-36f1dd4df9b3' AND wbs IN ('6.1.1','6.1.2','6.1.3');
-- 6.2 ギネス記録・申請
UPDATE tasks SET title='ギネス記録・申請: '||title WHERE event_id='e68a1a28-5213-4d6a-9ef2-36f1dd4df9b3' AND wbs IN ('6.2.1','6.2.2');
