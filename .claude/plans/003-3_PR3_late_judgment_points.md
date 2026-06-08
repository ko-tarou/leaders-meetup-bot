# PR3: 8:00 遅刻判定 + ポイント加算 + admin 免除

## 目的
平日 8:00 JST 締切後に、参加ボタンを押さなかったメンバーを「遅刻 (late)」として
`kejime_events` に +1pt 加算する。admin が後から免除 (取り消し) も可能。

## 前提
- PR1: kejime_members / kejime_events / morning_attendance / kejime_article_requests 存在
- PR2: morning-standup.ts が 7:30 と 8:00 の投稿 + 参加ボタン押下記録を実装済み

## 変更内容

### 1. `src/services/kejime-late-judge.ts` (新規 ~120行)
**主要関数:**
```ts
export async function processLateJudgment(d1, jst): Promise<void>
// 平日 8:00 JST 5分window で動作 (cron 駆動)
// 各 morning_standup の event_action ごとに:
//   1. 同日の morning_attendance で attended の slack_user_id 集合 A を取得
//   2. その action の kejime_tracker (同一 event 内) の kejime_members 一覧を取得
//      → 参加対象メンバー全員のリスト
//   3. members - A = 遅刻者集合 L
//   4. L の各メンバーについて:
//      - morning_attendance に status='late' を INSERT OR IGNORE
//      - 既に late/exemption が記録されていれば skip (dedupKey: kejime_member_id + date)
//      - kejime_events に type='late', points_delta=1 を INSERT
//      - kejime_members.current_points += 1 (5pt キャップ表示)
//      - current_points が 5 の倍数を超えたら ramen_count += 1 (自動加算)
//
// 多重起動防止: scheduledJobs.dedupKey = `kejime_late_judge:<eventActionId>:<YYYYMMDD>`

function bumpPointsAndRamen(member, delta): { newPoints, ramenBumped }
// pure function。テスタブル
// internal_pts := member.current_points + delta
// floor(internal/5) と floor(member.current_points/5) の差分が ramen 増分
```

### 2. admin API 追加 (`src/routes/api/kejime.ts` 新規, ~100行)
**エンドポイント:**
- `GET /api/orgs/:eventId/actions/:actionId/kejime/members` — members + 集計 (current_points, ramen_count, recent events)
- `GET /api/orgs/:eventId/actions/:actionId/kejime/events?from=&to=&type=` — 履歴
- `POST /api/orgs/:eventId/actions/:actionId/kejime/exemption` — 免除作成
  - body: `{ memberId, eventId, note }` — eventId は kejime_events.id (取り消し対象)
  - 動作: 対象 event の type='late' を確認 → `kejime_events` に type='exemption', points_delta=-1 を追加。元 event は残す (履歴保持)
  - `kejime_members.current_points -= 1` (0 でフロア)。ramen_count は触らない (誤遅刻と意図的取り消しは別)

`src/routes/api.ts` に kejime ルートを mount。adminAuth で保護。

### 3. cron 統合 (`src/index.ts`)
`processLateJudgment` を scheduled() に追加。平日 8:00 JST 5分window で起動。

### 4. テスト
`test/characterization/kejime/late-judgment.test.ts`:
- 平日 8:00 → attended 以外を late 認定 + +1pt
- 同じ action 2 回走らせても dedupKey で 1 回のみ
- 土日は走らない
- 4pt のメンバーが late → current_points=5, ramen_count 0
- 5pt のメンバーが late → current_points=6 内部, 表示=5, ramen_count=+1
- 9pt のメンバーが late → ramen_count=+1 (10pt 到達)

`test/characterization/kejime/kejime-admin-api.test.ts`:
- GET members で集計が返る
- POST exemption で points_delta=-1 が追加 + current_points -= 1
- exemption 対象が late ではない場合 400
- admin auth 必須 (x-admin-token なしで 401)

## ファイル構成 (目安)
- `src/services/kejime-late-judge.ts` (新規 ~120行)
- `src/routes/api/kejime.ts` (新規 ~100行)
- `src/routes/api.ts` (kejime ルート mount ~5行)
- `src/index.ts` (cron 呼び出し ~5行)
- テスト 2 ファイル (~200行)

## 制約
- PR 行数 200行以内 (本体のみ、テスト除外)
- ブランチ: `feature/morning-kejime-pr3`
- PR タイトル: `feat(kejime): 8:00 遅刻判定 + ポイント加算 + admin 免除 (朝勉強会 PR3)`
- main 向け
- typecheck + 全テスト pass
- 既存テストを 1 件も壊さない

## 重要な仕様確認
**ポイント計算ルール（再掲・確定）:**
- 遅刻: internal_points += 1
- 5 の倍数を **上向きに超えたら** ramen_count += 1 (5→1, 10→2, 15→3 …)
- 表示 current_points = min(internal_points, 5) — DB には internal を保存し、API/UI で min 適用
- ※ つまり `kejime_members.current_points` は **internal_points そのもの** を保存する設計に変更

→ PR1 で created した `current_points` カラムは internal_points として使う。
→ 表示時に min(x, 5) を適用する (UI層 or API レイヤで)。

## ramen 自動加算ロジック
```ts
function bumpPointsAndRamen(internalBefore: number, delta: number) {
  const internalAfter = Math.max(0, internalBefore + delta);
  const ramenBumped = Math.floor(internalAfter / 5) - Math.floor(internalBefore / 5);
  return { internalAfter, ramenBumped };
}
```
- delta=+1 (late) で internal=4→5 → ramenBumped=1
- delta=-1 (article) で internal=5→4 → ramenBumped=-1 (取り消し)
- delta=-1 (exemption) で internal=5→4 → ramenBumped=-1
→ 免除/記事承認で 5pt 越え→未満に戻ったら ramen も -1 する整合性

実装は `bumpPointsAndRamen` の pure function を共有して、late / article / exemption で再利用。
