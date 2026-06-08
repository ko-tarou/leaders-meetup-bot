# PR3: admin API（メンバー同期 / リンク管理）

## 目的

admin（`x-admin-token` 配下）のホワイトリスト管理 API を実装する。
メンバー同期・一覧（status のみ）・token 再発行・全会一致結果一覧。
**個人のリスト内容・件数は一切返さない。**

## 前提

- PR1 完了済み（3 テーブル + Drizzle schema）。
- role メンバーは `slack_role_members(role_id, slack_user_id, added_at)` → `slack_roles` を参照。
- display_name 解決は既存 `src/services/slack-names.ts` の `resolveDisplayName` を使う。
- token 生成は `src/routes/api/interviewers.ts` の `generateFormToken`（24 バイト hex）を参考に
  **32 バイト hex** で実装する。

## 変更内容

### 1. admin ルータ `src/routes/api/whitelist-admin.ts`（新規 ~150 行）

prefix: `/orgs/:eventId/actions/:actionId/whitelist`（adminAuth で保護される）。

```ts
// 共通: actionId → event_actions を引き actionType==="whitelist" を確認。
//       config から { workspaceId, roleId, notifyChannelId } を取り出す。

// POST .../members/sync
// 1. config.roleId の slack_role_members を全取得。
// 2. 各 slack_user_id について whitelist_members 行を ensure:
//    - 既存なし → display_name を resolveDisplayName で解決し、token 生成して INSERT。
//    - 既存あり → display_name を更新（任意）。token は維持。
// 3. role から外れたメンバーの行は **削除しない**（提出履歴を保持。下記メモ参照）。
// 4. 返却: { synced: 件数, members: [{ memberId, displayName, submitted, token }] }

// GET .../members
// whitelist_members 一覧。各行: { memberId, displayName, submitted (submitted_at!=null), token }
// ※ entries / 件数 / name_encrypted は絶対に含めない。

// POST .../members/:memberId/rotate-token
// token を再生成して UPDATE。返却: { memberId, token }
// （submitted 状態・entries はそのまま維持。リンクだけ失効）

// GET .../results
// whitelist_unanimous を event_action_id で取得。
// 返却: { results: [{ name: name_normalized, notifiedAt }] }
```

### 2. token 生成ヘルパ

```ts
function generateMemberToken(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
}
```
> 32 バイト → hex 64 文字。`whitelist_members.token` の UNIQUE 制約と index は PR1 で作成済み。

### 3. ルータマウント（`src/routes/api.ts`）

```ts
api.route("/", whitelistAdminRouter);
```
> コメント: 「007 宗教 PR3: ホワイトリスト admin API
> (`/orgs/:eventId/actions/:actionId/whitelist/*`、adminAuth で保護)。」
> 公開ルート（PR2 の `/whitelist/:token`）とは prefix が異なるため衝突しない。

## プライバシー保証（セキュリティ #5 への対応）

- `GET .../members` のレスポンス型に `nameEncrypted` / `entries` / `count` 系フィールドを一切含めない。
- `GET .../results` は既に Slack に公開済みの `name_normalized` のみ。
- テストで「members / results レスポンスに個人リスト内容・件数が無い」ことを明示的に検証する。

## テスト

`test/characterization/whitelist/whitelist-admin.test.ts`:
- members/sync: role メンバー分の whitelist_members を作成（token 付き）。
- members/sync: 冪等 — 2 回実行しても重複行を作らず token を維持。
- members/sync: role から外れたメンバーの行を削除しない。
- members: status（submitted true/false）+ token を返す。**内容/件数を返さない**（明示アサート）。
- rotate-token: token が変わり、submitted 状態は維持。
- results: 通知済み全会一致名前のみ返す。
- 非 whitelist action の actionId → 404/400。

## ファイル構成

- `src/routes/api/whitelist-admin.ts`（新規 ~150 行）
- `src/routes/api.ts`（~3 行追加）
- テスト 1 ファイル（本体行数外）

## 制約

- **PR 行数 200 行以内（本体のみ）**。目安 ~180 行。
- ブランチ: `feature/shukyo-whitelist-pr3`
- PR タイトル: `feat(whitelist): admin API メンバー同期/リンク管理 (宗教 PR3)`
- main 向け。typecheck + lint + 全テスト pass。

## 設計判断メモ

### 削除メンバーの行を消さない理由

role から外れたメンバーの `whitelist_members` 行を sync で削除すると、
過去の提出が失われ、再追加時に submitted 状態がリセットされて UX が悪い。
また consensus は「**現 role メンバー**」だけを対象に集計する（PR4）ので、
外れたメンバーの古い行が残っていても全会一致判定には影響しない。
→ **論理的に無害かつ履歴保持に有利なので残す**。
（将来クリーンアップが必要なら別途 admin 削除 API を検討。今は不要・YAGNI。）

### display_name 解決

`resolveDisplayName(slack, slackUserId)` を使う。ワークスペースが「宗教」専用の別ワークスペースのため、
`config.workspaceId` の bot token で初期化した slack client を渡す。
（slack client 初期化は既存の workspace 解決ヘルパに合わせる。）
