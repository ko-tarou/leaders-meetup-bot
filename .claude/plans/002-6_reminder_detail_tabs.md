# 002-6 weekly_reminder 詳細画面の 3 タブ構造化 (Sprint 23 PR-BC)

## ゴール

PR-A で暫定的に ReminderCard を流用していた `WeeklyReminderDetailPage` を、
3 サブタブ構造 (メイン / チャンネル管理 / 時刻設定) に再構成する。
チャンネル管理タブは task_management の `ChannelManagementSection` と同等の UX
(workspace selector + 検索 + ページネーション) を提供する。

## ブランチ・PR

- ブランチ: `feature/weekly-reminder-detail-tabs`
- PR base: `main`
- PR タイトル: `feat(weekly-reminder): 詳細画面を 3 タブ構造に + チャンネル管理を task_management 互換に (Sprint 23 PR-B/C)`

## ファイル

| ファイル | 行数目安 | 種別 |
|---|---|---|
| `frontend/src/pages/WeeklyReminderDetailPage.tsx` | ~120 (再構成) | 修正 |
| `frontend/src/components/ReminderMainTab.tsx` | ~120 | 新設 |
| `frontend/src/components/ReminderChannelTab.tsx` | ~300 | 新設 |
| `frontend/src/components/ReminderTimeTab.tsx` | ~80 | 新設 |

## 仕様サマリ

### サブタブ ([メイン] [チャンネル管理] [時刻設定])

- 既存パンくず + 「← 一覧に戻る」ボタンは維持
- パンくず下に navigation を表示
- アクティブタブは内部 state で管理 (URL ?tab= は省略)

### メインタブ

- リマインド名 (text input、必須)
- メッセージ本文 (textarea)
- 有効スイッチ (checkbox)
- 「保存」ボタン押下時のみ save

### チャンネル管理タブ (即時保存)

- workspace selector (`<select>`)
- 検索 input (チャンネル名)
- PAGE_SIZE = 20 のページネーション
- 既登録チャンネル (= reminder.channelIds) 一覧と「× 削除」ボタン
- 利用可能チャンネル (bot 参加中・未登録) 一覧と「+ 追加」ボタン
- 未知 ID は ID のままフォールバック表示
- 「+ 追加」「× 削除」を押した瞬間に即時 save (task_management と同じ)

### 時刻設定タブ

- 曜日 select
- ChipInput (inputType="time", sort) で複数時刻
- 「保存」ボタン押下時のみ save

## コミット分割

1. `feat(weekly-reminder): 詳細画面サブタブ navigation の骨格を追加`
2. `feat(weekly-reminder): メインタブ (名前/メッセージ/on-off) を実装`
3. `feat(weekly-reminder): 時刻設定タブを実装`
4. `feat(weekly-reminder): チャンネル管理タブ (workspace+検索+ページング) を実装`
5. `chore(weekly-reminder): 詳細画面の暫定 ReminderCard 流用部分を削除`

## 品質ゲート

- `npm run typecheck` → 0 エラー
- `npm run build:frontend` → 0 エラー

## 禁止事項

- backend 変更
- ChannelManagementSection.tsx 自体の修正
- attendance_check の変更
- マイグレーション
- デプロイ・マージ

## レビュー観点

1. ReminderChannelTab の UI が ChannelManagementSection と十分に近いか
2. データモデルの違い (meetings table vs channelIds 配列) が正しく扱えているか
3. 即時保存と通常保存のタブごとの使い分けが UX として適切か
4. 未知 ID のフォールバック表示が動くか
5. タブ切替で未保存の編集内容が失われる挙動の説明が PR 本文にあるか
