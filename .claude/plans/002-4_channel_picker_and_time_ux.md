# 002-4 channel picker + 時刻 UX 改善 (Sprint 23 PR4)

## 目的

kota さんから 2 点フィードバック:
1. 時刻チップ入力が「複数追加できる」ことが UI で分かりづらい (UX 改善)
2. チャンネル ID 直打ちではなく `#channel-name` で選択したい (新規 MultiChannelSelector + 既存 ChannelSelector 流用)

## 変更ファイル

| # | ファイル | 操作 | 行数目安 |
|---|---------|------|---------|
| 1 | `frontend/src/components/MultiChannelSelector.tsx` | 新規 | ~100 |
| 2 | `frontend/src/components/ReminderCard.tsx` | 修正 | ~30 差分 |
| 3 | `frontend/src/components/WeeklyReminderForm.tsx` | 修正 | ~5 差分 (prop 透過) |
| 4 | `frontend/src/components/AttendanceCheckForm.tsx` | 修正 | ~20 差分 |
| 5 | `frontend/src/pages/ActionDetailPage.tsx` | 修正 | ~10 差分 (workspaceId 受け渡しは optional) |

合計: ~165 行 (200 行ガイドライン以内)

## 実装方針

### MultiChannelSelector
- `ChannelSelector` をベースに `value: string` → `values: string[]` に拡張
- 上部にチップ表示エリア (× で削除)
- 下部に dropdown (既選択 ID は除外)
- 既知 ID は `#name`、未知 ID は ID をそのまま表示してフォールバック
- bot 参加チャンネル 0 件 / loading の表示は ChannelSelector と同じ

### ReminderCard
- 時刻 ChipInput のラベル: `送信時刻 (JST、HH:MM。複数設定可)`
- ChipInput の下にヘルパーテキスト 1 行: `「追加」ボタンまたは Enter で時刻を追加できます`
- channelIds の ChipInput を MultiChannelSelector に置き換え
- 新 prop: `workspaceId?: string`

### AttendanceCheckForm
- 投稿チャンネル ID の `<input>` を 単一 `ChannelSelector` に置き換え
- 新 prop: `workspaceId?: string`

### WeeklyReminderForm
- ReminderCard に `workspaceId` を prop 透過
- 新 prop: `workspaceId?: string`

### ActionDetailPage
- WeeklyReminderForm / AttendanceCheckForm 呼び出し箇所に `workspaceId={undefined}` を渡す (今回は明示しない、ChannelSelector の default WS フォールバックを使う)

注: workspaceId 未指定時は `getSlackChannels()` が default workspace を返す既存挙動に乗る (ChannelSelector の現行ロジックと同じ)。完璧な多 WS 対応は別 PR で行う。

## 互換性

- 既存 config の `channelIds: string[]` は文字列 ID のままで保存・読み込みする
- 表示のみ name 解決
- 未知 ID は ID をそのままチップに出してフォールバック (赤背景なし)

## コミット分割

1. `feat(ui): MultiChannelSelector を新設`
2. `feat(weekly-reminder): channelIds 入力を MultiChannelSelector に置き換え`
3. `feat(attendance): channelId 入力を ChannelSelector に置き換え`
4. `feat(weekly-reminder): 時刻チップにヘルパーテキストを追加`

## 品質ゲート

- `npm run typecheck`
- `npm run build:frontend`
両方 0 エラー。

## ブランチ / PR

- branch: `feature/channel-picker-and-time-ux`
- base: `main`
- title: `feat(ui): チャンネル名選択 + 時刻 UX 改善 (Sprint 23 PR4)`
