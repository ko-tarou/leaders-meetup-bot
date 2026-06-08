# PR2: 朝活リマインダー投稿 (7:30/8:00 cron + 曜日テーマ + 参加ボタン)

## 目的
平日 7:30 JST にリマインダー + 参加ボタンを投稿、8:00 JST に締切投稿を出す cron 機能を実装する。
ボタン押下の attendance 記録までを範囲に含む（実際の遅刻判定とポイント加算は PR3）。

## 変更内容

### 1. `src/services/morning-standup.ts` (新規)
weekly-reminder.ts と同じ「dedupKey + scheduledJobs」パターンで実装。

**主要関数:**
```ts
export async function processMorningStandup(d1, slack, jst): Promise<void>
// 7:30 JST 5分window → リマインダー投稿
// 8:00 JST 5分window → 締切投稿
// 平日のみ (土日スキップ)
// action_type='morning_standup' enabled の全 event_actions を巡回

function buildReminderBlocks(theme, date): Block[]
// 7:30 投稿の Slack Block Kit
// 「📚 今日もあります - 火曜日は フロントエンド」
// 「集合: 8:00 / 場所: <省略>」
// 参加ボタン (action_id: morning_attend:<eventActionId>:<date>)

function buildCloseBlocks(date, attendeeCount): Block[]
// 8:00 投稿の Slack Block Kit
// 「⏰ 朝活、締め切りです (本日の出席: N名)」
```

**設定スキーマ:**
```json
{
  "schemaVersion": 1,
  "channelId": "C01ABC",
  "roleId": "<勉強会チーム role uuid>",
  "themes": {
    "mon": "ハードウェア",
    "tue": "フロントエンド",
    "wed": "バックエンド",
    "thu": "Android",
    "fri": "Unity"
  }
}
```

### 2. ボタン押下ハンドラ
既存の `src/routes/slack-interactions.ts` (もしくは類似) に hook を追加。
- action_id が `morning_attend:` で始まったら handle
- `morning_attendance` テーブルに `INSERT OR IGNORE` で status='attended' を記録
- Slack ephemeral 応答「✅ 参加を記録しました」
- 既に押した人には「既に記録済みです」を ephemeral 返信

### 3. cron 拡張 (`src/index.ts`)
`scheduled()` 内に `processMorningStandup` の呼び出しを追加。
JST window 判定は既存の `isDailyRosterSyncWindow` パターンに従う。
平日判定: `[1,2,3,4,5].includes(jstDayOfWeek)` (月-金)。

### 4. テスト
`test/characterization/kejime/morning-standup.test.ts`:
- 7:30 平日 → リマインダー post 1回呼ばれる + dedupKey 重複で2回目は呼ばれない
- 7:30 土日 → post されない
- 8:00 平日 → 締切 post + attendeeCount 表示
- enabled=0 のアクションはスキップ
- channelId null のアクションはスキップ (warn ログのみ)

`test/characterization/kejime/morning-attendance-handler.test.ts`:
- 参加ボタン押下 → morning_attendance に INSERT
- 同日同ユーザー2回押下 → 1レコードのみ
- ephemeral 応答が返ること

## ファイル構成
```
src/services/morning-standup.ts            (新規 ~150 lines)
src/routes/slack-interactions.ts           (既存に hook 追加 ~20 lines)
src/index.ts                                (cron 呼び出し追加 ~5 lines)
test/characterization/kejime/morning-standup.test.ts        (新規 ~80 lines)
test/characterization/kejime/morning-attendance-handler.test.ts (新規 ~50 lines)
```

## 制約
- PR 行数 200行以内 (本体 150 / テスト 130 を目安、テストはカウント外として運用)
- コミット 50行/コミット目安
- ブランチ: `feature/morning-kejime-pr2`
- PR タイトル: `feat(kejime): 朝活リマインダー投稿 7:30/8:00 (朝勉強会 PR2)`
- main 向け
- typecheck + 全テスト pass 必須
- PR1 の `morning_standup` 種別を使う前提
