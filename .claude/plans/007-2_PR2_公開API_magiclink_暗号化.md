# PR2: 公開 magic-link API + crypto 暗号化

## 目的

メンバー毎 magic-link の公開 API（`GET/POST /api/whitelist/:token`）を実装する。
POST は名前を AES-256-GCM で暗号化して entries を置換し `submitted_at` をセット、
その後 consensus チェックを呼ぶ（PR4 で実装される `checkConsensus` を import）。

## 前提

- PR1 完了済み（3 テーブル + Drizzle schema 存在）。
- 暗号化は既存 `src/services/crypto.ts` の `encryptToken(plaintext, key)` / `decryptToken(enc, key)` を使う。
  鍵は wrangler secret `WORKSPACE_TOKEN_KEY`（`c.env.WORKSPACE_TOKEN_KEY`）。
- token 検証の流儀は参加届 `src/routes/api/participation.ts` の `/participation/:eventId/prefill`
  （token 完全一致 + スコープ照合）を踏襲する。

## 変更内容

### 1. 公開ルータ `src/routes/api/whitelist-public.ts`（新規 ~120 行）

```ts
export const whitelistPublicRouter = new Hono<{ Bindings: Env }>();

// GET /api/whitelist/:token
// 1. token で whitelist_members を引く。無ければ 404。
// 2. member → event_action を引き、actionType が "whitelist" でなければ 404（スコープ検証）。
// 3. その member の entries を全件取得し decryptToken で復号。
// 4. 返却: { displayName, names: string[], submitted: boolean }
//    ※ token / 他メンバー情報 / slackUserId は返さない（最小限）。

// POST /api/whitelist/:token
// body: { names: string[] }
// 1. token 検証（GET と同じ）。404/型不一致は拒否。
// 2. バリデーション:
//    - names は配列、各要素は string。
//    - 各名前を normalizeName で正規化（NFKC + trim + 内部空白圧縮）。
//    - 空文字は除外、正規化後重複は排除。
//    - 上限件数（例: 50 件）・1 名前の最大長（例: 100 文字）でガード。
// 3. D1 batch で原子的に置換:
//    DELETE FROM whitelist_entries WHERE member_id = ?
//    INSERT ... (encryptToken した name_encrypted を各行)
// 4. whitelist_members.submitted_at = now, updated_at = now を UPDATE。
// 5. checkConsensus(db, eventActionId, slackClient) を呼ぶ（fail-soft）。
// 6. 返却: { ok: true, names: 正規化済み配列 }
```

### 2. 正規化ヘルパ `src/services/whitelist-normalize.ts`（新規 ~15 行）

```ts
export function normalizeName(raw: string): string {
  return raw
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ");
}
```
> PR2 / PR4 / フロントで共有する単一の真実。

### 3. consensus 呼び出しの境界

PR2 単体でビルドが通るよう、以下のどちらか:
- **推奨**: PR4 が `src/services/whitelist-consensus.ts` に `checkConsensus` を実装する前提で、
  PR2 では同ファイルに **no-op stub** を置く（`export async function checkConsensus(...) { /* PR4 で実装 */ }`）。
  PR4 が中身を埋める。これにより PR2 は独立してビルド可能。
- POST は `checkConsensus` を `c.executionCtx.waitUntil(...)` で非同期化（3 秒制限・fail-soft）。

### 4. 公開ルート除外登録（`src/routes/api.ts`）

admin-auth ミドルウェア（~64 行のバイパス条件）に追加:
```ts
sub.startsWith("/whitelist/") ||
```
> コメント: 「007 宗教 PR2: ホワイトリストのメンバー向け magic-link 公開フォーム
> (`/whitelist/:token` GET/POST)。admin auth を除外し、token で検証する。」

ルータをマウント（~105 行付近）:
```ts
api.route("/", whitelistPublicRouter);
```

## token / スコープ検証（セキュリティ #6 への対応）

- token は完全一致のみ。前方一致や緩い比較はしない。
- member 経由で event_action を引き、`actionType === "whitelist"` を必須にする
  （他種別 action の token を使い回せないように）。
- token 不一致・該当なし・型不一致は **404**（情報を漏らさない）。

## テスト

`test/characterization/whitelist/whitelist-public.test.ts`:
- GET: 正常 token → 復号済み names + displayName + submitted を返す。
- GET: 不正 token → 404。
- GET: whitelist 以外の action に紐づく token → 404。
- POST: names を暗号化して entries 置換、submitted_at セット。
- POST: 再提出で entries が**置換**される（追記でなく）。
- POST: 正規化（全角/半角・前後空白・連続空白）+ 重複排除。
- POST: 空文字除外、上限超過のガード。
- POST: checkConsensus が呼ばれる（stub をスパイ）。
- ラウンドトリップ: encryptToken → decryptToken で元の名前に戻る。

`test/characterization/whitelist/whitelist-normalize.test.ts`:
- NFKC / trim / 空白圧縮の各ケース。

## ファイル構成

- `src/routes/api/whitelist-public.ts`（新規 ~120 行）
- `src/services/whitelist-normalize.ts`（新規 ~15 行）
- `src/services/whitelist-consensus.ts`（stub ~5 行、PR4 で実装）
- `src/routes/api.ts`（~3 行追加）
- テスト 2 ファイル（本体行数外）

## 制約

- **PR 行数 200 行以内（本体のみ）**。目安 ~190 行。
- ブランチ: `feature/shukyo-whitelist-pr2`
- PR タイトル: `feat(whitelist): 公開 magic-link API + crypto 暗号化 (宗教 PR2)`
- main 向け。typecheck + lint + 全テスト pass。

## 設計判断メモ

- **delete-then-insert 置換**: 名前 1 件 = 1 行のモデルで提出が「上書き」セマンティクスのため、
  毎回その member の entries を全削除して入れ直す。D1 の batch でまとめて原子的に実行。
- **submitted_at の順序**: entries 置換が成功してから submitted_at を立てる
  （失敗時に「提出済みなのに中身が無い」状態を避ける）。
- **fail-soft**: Slack 通知（consensus 内）失敗で保存をロールバックしない。
- **IV 再利用なし**: `encryptToken` は呼び出し毎にランダム IV を生成するため、同名を複数 member が登録しても安全。
