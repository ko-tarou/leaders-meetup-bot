# PR4: けじめステータス自動再投稿 (毎朝)

## 目的
毎朝 8:05 JST 頃に「けじめチャンネル」に最新のステータス (ポイント / 激辛累計 / 申請待ち) を投稿する。

## 前提
- PR1-3 完了済み
- kejime_members, kejime_events, kejime_article_requests テーブル存在
- `kejime_tracker` action_type 登録済み
- `bumpPointsAndRamen` pure function 公開済み (`src/services/kejime-late-judge.ts`)

## 変更内容

### 1. `src/services/kejime-status-post.ts` (新規 ~150行)
**主要関数:**
```ts
export async function processKejimeStatusPost(d1, slack, jst): Promise<void>
// 平日 8:05 JST 5分window (= 遅刻判定完了後)
// 各 kejime_tracker action_type ごとに:
//   1. config.kejimeChannelId が null なら skip (warn ログのみ)
//   2. kejime_members を取得 (current_points, ramen_count, display_name)
//   3. 申請待ち記事を取得 (kejime_article_requests where status='pending')
//   4. buildStatusBlocks() で Slack Block Kit を構築
//   5. channelId に新規投稿 (古い投稿は触らない・流れる前提)
//   6. dedupKey: kejime_status_post:<eventActionId>:<YYYYMMDD>

function buildStatusBlocks(members, articleRequests, dateLabel): Block[]
// pure function (テスタブル)
// ヘッダー: ☕ 朝活けじめステータス ─ YYYY-MM-DD (曜)
// 🌶 激辛累計: name×N / name×N
// 📊 ポイント (5pt ロック): 棒グラフ風 ████░ N pt
// 📝 記事申請待ち: - name: URL (申請中・いいね待ち)
```

### 2. cron 統合 (`src/index.ts`)
`processKejimeStatusPost` を scheduled() に追加。
8:05 JST window (jst.hour === 8 && jst.minute >= 5 && jst.minute < 10) で起動。
土日は skip。

### 3. テスト
`test/characterization/kejime/kejime-status-post.test.ts`:
- buildStatusBlocks の出力スナップショット
- channelId null なら post されない
- 平日 8:05 → post 1回
- 同一日重複 → dedupKey で skip
- 土日 → skip

`test/characterization/kejime/kejime-status-blocks.test.ts`:
- 表示ポイントが min(current_points, 5) でキャップ
- 棒グラフが正しく描画 (4pt → ████░)
- 申請待ち 0 件のセクションは表示しない
- ramen 累計 0 のセクションは表示しない

## ファイル構成
- `src/services/kejime-status-post.ts` (新規 ~150行)
- `src/index.ts` (~5行追加)
- テスト 2 ファイル (~150行)

## 制約
- PR 行数 200行以内 (本体)
- ブランチ: `feature/morning-kejime-pr4`
- PR タイトル: `feat(kejime): けじめステータス自動再投稿 8:05 JST (朝勉強会 PR4)`
- main 向け
- typecheck + 全テスト pass

## 投稿フォーマット詳細

```
☕ 朝活けじめステータス ─ 2026-05-26 (火)

🌶 激辛ラーメン累計
  田中 ×2 / 佐藤 ×1

📊 現在のポイント (5pt ロック表示)
  山田  ████░ 4 pt
  鈴木  ██░░░ 2 pt
  高橋  ░░░░░ 0 pt

📝 記事申請待ち
  • 山田: https://qiita.com/foo/items/xxx (いいね待ち)
```

- 「激辛累計」「申請待ち」セクションは該当データがない場合は section ごと省略
- 「現在のポイント」セクションは全員が 0 でも表示 (空状態に「全員 0pt - 立派です！」)
- 棒グラフは displayPoints (min(internal, 5)) で描画
