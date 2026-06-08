# PR5: 記事URL申請 + Qiita検証 + いいね承認

## 目的
- けじめチャンネルに投稿された Qiita URL を検出
- 自動で本文文字数を取得し 500 文字未満は自動却下
- 「勉強会チーム」ロール所属者のいいね reaction で承認 → -1pt + ramen 再計算
- 却下時は通知

## 前提
- PR1-4 完了済み
- `kejime_article_requests` テーブル存在
- `bumpPointsAndRamen` pure function 公開済み
- Slack Events API は `src/routes/slack/events.ts` で受信中 (message, member_joined_channel)
- reaction_added events は **未購読** (購読設定はユーザー側で別途必要、コードは受け取れる前提で実装)

## 変更内容

### 1. `src/services/qiita-validator.ts` (新規 ~80行)
**主要関数:**
```ts
export function parseQiitaUrl(url: string): { user: string; itemId: string } | null
// https://qiita.com/<user>/items/<id> をパース
// 末尾 ? や # 付きでもOK

export async function fetchQiitaBodyLength(
  itemId: string,
  fetch: typeof globalThis.fetch
): Promise<{ ok: true; length: number } | { ok: false; reason: 'not_found' | 'fetch_error' }>
// https://qiita.com/api/v2/items/<id> を fetch
// 200 のみ ok。404 → not_found。それ以外 → fetch_error
// body は markdown 文字数で計測 (rendered_body ではなく body)
```

### 2. `src/services/kejime-article-flow.ts` (新規 ~120行)
**主要関数:**
```ts
export async function handleKejimeChannelMessage(d1, slack, fetch, event): Promise<void>
// 1. event.channel が kejime_tracker の kejimeChannelId に該当するかチェック
//    (全 kejime_tracker actions を引いて、channelId と照合)
// 2. event.text から Qiita URL 抽出 (1 つでも見つかれば最初の 1 件のみ処理)
// 3. URL なし → return
// 4. URL あり:
//    a. parseQiitaUrl で itemId 取得
//    b. 失敗 → kejime_article_requests に status='rejected_domain' INSERT + 通知
//    c. 成功 → fetchQiitaBodyLength
//    d. 200 → body_length が 500 未満なら status='rejected_short' + 通知
//                 500 以上なら status='pending' + 「いいね待ち」通知 (thread reply)
//    e. fetch 失敗 → status='rejected_fetch_error' (admin 手動承認待ち) + 通知

export async function handleKejimeReactionAdded(d1, slack, event): Promise<void>
// reaction_added event
// 1. event.reaction が thumbsup/+1/いいね相当かチェック (許可リスト)
// 2. event.item.channel が kejime_tracker の kejimeChannelId に該当か
// 3. event.item.ts に紐づく kejime_article_requests を取得 (thread_ts または message_ts で)
// 4. request が status='pending' でなければ skip
// 5. event.user が「勉強会チーム」ロール所属者か確認 + 自分自身ではないか
// 6. 承認: status='approved', decided_by, decided_at 更新
//    member.current_points -= 1, ramen_count += ramenBumped (bumpPointsAndRamen で計算)
//    kejime_events に type='article', points_delta=-1, ref=qiita_url を追加
//    通知: 「✅ 記事承認しました (-1pt)」

const ARTICLE_REACTIONS = new Set(["+1","thumbsup","いいね","raised_hands"]);
```

### 3. Events ルーティング統合 (`src/routes/slack/events.ts`)
- message event: handleKejimeChannelMessage を呼ぶ (既存 handleMessageEvent と並行)
- reaction_added event: handleKejimeReactionAdded を呼ぶ (新規 case 追加)

すべて `c.executionCtx.waitUntil` で非同期化 (3秒制限対応)。

### 4. テスト
`test/characterization/kejime/qiita-validator.test.ts`:
- parseQiitaUrl: 正常 / クエリ付き / ハッシュ付き / 不正 URL
- fetchQiitaBodyLength: mock fetch で 200/404/500 ケース

`test/characterization/kejime/kejime-article-flow.test.ts`:
- 非 kejime channel への投稿は無視
- 非 Qiita URL → rejected_domain + 通知
- Qiita URL 500未満 → rejected_short + 通知
- Qiita URL 500以上 → pending + 「いいね待ち」通知
- Qiita API 404 → rejected_fetch_error
- reaction_added: 勉強会チーム member → 承認 + -1pt
- reaction_added: 非ロール member → skip
- reaction_added: 自己リアクション → skip
- reaction_added: 既に approved → skip (二重承認なし)

## ファイル構成
- `src/services/qiita-validator.ts` (新規 ~80行)
- `src/services/kejime-article-flow.ts` (新規 ~120行)
- `src/routes/slack/events.ts` (~15行追加)
- テスト 2 ファイル (~250行)

## 制約 (厳守)
- **PR 行数 200行以内 (本体のみカウント、テスト除外)**
  - 厳しい場合: テスト関数や 1 ヘルパーを次 PR へ繰り越し可。最終手段はコメント圧縮
- ブランチ: `feature/morning-kejime-pr5`
- PR タイトル: `feat(kejime): 記事URL申請 + Qiita検証 + いいね承認 (朝勉強会 PR5)`
- main 向け
- typecheck + 全テスト pass

## 設計判断メモ

### ロール所属者判定
`role_members` テーブル (既存) を `role_id = config.roleId AND slack_user_id = event.user` で SELECT。
1 件あれば所属者。

### 自己リアクション
event.user (リアクション主) と kejime_article_requests.member_id 経由の kejime_members.slack_user_id を比較。

### thread_ts と message_ts の使い分け
**「いいね待ち」状態の管理**: bot が thread reply を投げた場合、その reply ではなく **元のメッセージ (event.ts)** をターゲットにユーザーがリアクションする想定。
→ `kejime_article_requests.thread_ts` に **元 message_ts** を保存 (列名は thread_ts のままだが、ユーザー投稿の ts を入れる)。

### 通知フォーマット
- rejected_domain: 「⚠️ Qiita 記事のみ受け付けています」(thread reply)
- rejected_short: 「⚠️ 記事の分量が少ないため却下です ({N}文字 / 必要 {min}文字)」
- rejected_fetch_error: 「⚠️ 記事取得に失敗しました。admin の手動承認をお待ちください」
- pending: 「✅ Qiita 記事受領 ({N}文字)。勉強会チームのいいねで承認されます」
- approved: 「🎉 承認しました (-1pt)」

### Qiita API のレート制限とエラー耐性
- 認証なしで 60req/h (= 1 req/min)
- 朝勉強会の規模では充分
- 失敗時は status='rejected_fetch_error' で記録 → admin 手動承認パスを残す
- (admin 手動承認エンドポイントは将来 PR で。今は status を持つだけ)

### qiita.com 以外のドメイン
parseQiitaUrl が null を返す。即 rejected_domain。
