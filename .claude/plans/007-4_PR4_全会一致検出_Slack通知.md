# PR4: 全会一致検出サービス + Slack 通知

## 目的

全会一致（strict unanimity）を検出して Slack 通知を投稿する `checkConsensus` を実装し、
PR2 の POST に配線する。PR2 で置いた no-op stub を本物に差し替える。

## 前提

- PR1（schema）+ PR2（公開 API + stub `checkConsensus`）完了済み。
- 名前正規化は `src/services/whitelist-normalize.ts` の `normalizeName`（PR2 で作成）を再利用。
- 復号は `decryptToken(enc, c.env.WORKSPACE_TOKEN_KEY)`。
- role メンバーは `slack_role_members`（config.roleId）。

## 変更内容

### `src/services/whitelist-consensus.ts`（PR2 の stub を実装、~120 行）

```ts
export async function checkConsensus(
  db: DrizzleD1,
  eventActionId: string,
  slack: SlackClient,           // config.workspaceId の bot token で初期化済み
  notifyChannelId: string | null,
  masterKey: string,            // WORKSPACE_TOKEN_KEY
): Promise<void> {
  // 1. event_action の config から roleId を取得。roleId / notifyChannelId が無ければ return。
  // 2. config.roleId の slack_role_members を全取得 = 現メンバー集合 (slackUserIds)。
  //    メンバー 0 人なら return。
  // 3. 各 slack_user_id について whitelist_members 行を引く:
  //    - 行が無い、または submitted_at が null のメンバーが 1 人でもいれば → return（待つ）。
  // 4. 全員提出済み → 各 member の entries を全件 decryptToken して normalizeName。
  //    member 毎に Set<normalizedName> を作る。
  // 5. 全 member の Set の積集合（intersection）を取る。
  // 6. intersection の各 name について:
  //    - whitelist_unanimous に INSERT を試みる（UNIQUE(event_action_id, name_normalized)）。
  //    - UNIQUE 違反 = 既通知 → skip（idempotent）。
  //    - 新規 INSERT 成功 → Slack 投稿:
  //      「全員が『<name>』を希望しています。誘いましょう。」（個人特定なし）
  // 7. Slack 失敗は fail-soft（try/catch + console.warn、return を妨げない）。
}
```

### 配線（`src/routes/api/whitelist-public.ts`、PR2 が作成）

POST の最後で stub 呼び出しを本実装に差し替え。
- slack client は `config.workspaceId` の bot token で初期化（既存 workspace 解決ヘルパ）。
- `c.executionCtx.waitUntil(checkConsensus(...))` で非同期化（3 秒制限・fail-soft）。
- workspaceId / notifyChannelId 未設定なら consensus はスキップ（投稿先が無いので何もしない）。

## 全会一致セマンティクス（厳密 — 再確認）

- メンバー集合 = **現 role メンバー**（`slack_role_members` の現在値。過去メンバーは無視）。
- 全会一致 = 全現メンバーが submitted 済み **かつ** その名前が全員の Set に含まれる。
- 1 人でも未提出 → 通知ゼロ（催促もしない）。
- 通知は dedup（同名は二度通知しない）。

## テスト

`test/characterization/whitelist/whitelist-consensus.test.ts`:
- 全員提出 + 共通名あり → unanimous INSERT + Slack 投稿 1 回。
- 1 人未提出 → 通知ゼロ（return）。
- whitelist_members 行が無いメンバーがいる → 通知ゼロ。
- 共通名なし → 通知ゼロ。
- 既に unanimous にある名前 → 再通知しない（dedup）。
- 複数共通名 → それぞれ 1 回ずつ通知。
- Slack 投稿失敗 → throw せず（fail-soft）、unanimous レコードは残る方針か否かを検証
  （INSERT 後に投稿 → 投稿失敗時は次回再投稿したいので **投稿成功後に INSERT** にするか要決定。下記メモ）。
- 正規化マッチ: 全角/半角・空白差を吸収して一致する。

## ファイル構成

- `src/services/whitelist-consensus.ts`（stub → ~120 行に実装）
- `src/routes/api/whitelist-public.ts`（POST の配線 ~10 行差し替え）
- テスト 1 ファイル（本体行数外）

## 制約

- **PR 行数 200 行以内（本体のみ）**。目安 ~150 行。
- ブランチ: `feature/shukyo-whitelist-pr4`
- PR タイトル: `feat(whitelist): 全会一致検出 + Slack 通知 (宗教 PR4)`
- main 向け。typecheck + lint + 全テスト pass。

## 設計判断メモ

### INSERT と Slack 投稿の順序（fail-soft の整合）

2 案:
- **案 A（INSERT 先）**: unanimous に INSERT → Slack 投稿。投稿失敗しても再通知されない（取りこぼし）。
- **案 B（投稿先）**: Slack 投稿成功 → unanimous に INSERT。投稿失敗時は次回 POST で再試行される。
  ただし同時 POST で二重投稿の競合余地がわずかに残る。

**推奨: 案 B（投稿成功後に INSERT）**。理由: 通知の取りこぼしより、稀な二重投稿のほうが害が小さい。
UNIQUE 制約があるので INSERT 段階で二重は弾かれ、通知は最大 1 回多い程度。
ただし fail-soft の「保存はロールバックしない」原則（フォーム保存自体）は維持。consensus は提出保存とは別トランザクション。

### 復号コスト

N メンバー × M 名前の復号。N≈数名・M≈数十なので問題なし（DB アーキテクト #4 と整合）。
importKey を毎回行う点は許容（規模小）。

### slack client の初期化

「宗教」は別ワークスペースなので、`config.workspaceId` の暗号化 bot_token を `decryptToken` で復号して client を作る。
既存の workspace 解決パターン（kejime / weekly_reminder で channel 投稿しているコード）に合わせる。
