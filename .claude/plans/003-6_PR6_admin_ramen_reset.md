# PR6: 激辛リセット API + kejime admin UI

## 目的
- admin 専用「激辛リセット」エンドポイントを実装
- `kejime_tracker` action 配下に admin UI を追加
  - メンバー一覧 (display name / current_points (内部) / displayPoints / ramen_count)
  - 各メンバーの「激辛リセット」ボタン
  - 履歴 (kejime_events) の最新 N 件表示
  - 申請待ち記事一覧 + admin 手動承認ボタン (rejected_fetch_error の救済)

## 前提
- PR1-5 完了済み
- ramen の **自動加算** は PR3 の bumpPointsAndRamen で既に動作中 → PR6 は **リセットUI** に集中

## 変更内容

### 1. admin API 拡張 (`src/routes/api/kejime.ts`)
**追加エンドポイント:**
- `POST /api/orgs/:eventId/actions/:actionId/kejime/ramen-reset`
  - body: `{ memberId, note? }`
  - 動作:
    - `kejime_members.ramen_count = 0` に UPDATE
    - `kejime_events` INSERT (type='ramen_reset', ramen_delta=-prevCount, note)
    - **current_points (internal) は触らない** (運用判断: 5pt 蓄積はそのまま残し、激辛のみ消す)
- `POST /api/orgs/:eventId/actions/:actionId/kejime/article-manual-approve`
  - body: `{ articleRequestId, decidedBy?, note? }`
  - 動作: rejected_fetch_error or pending の article を admin 強制承認 → -1pt
  - bumpPointsAndRamen で計算
- `GET /api/orgs/:eventId/actions/:actionId/kejime/articles?status=pending|all` — 申請一覧

### 2. frontend 新規コンポーネント
`frontend/src/components/kejime/KejimeAdminTab.tsx` (新規 ~120行):
- API fetch: members + events + articles
- 表形式表示
- 「リセット」ボタン → 確認ダイアログ → POST
- 「承認 (手動)」「却下 (admin)」ボタン

`frontend/src/pages/action-detail/ActionMainContent.tsx`:
- `case 'kejime_tracker'`: `<KejimeAdminTab eventId actionId={action.id} />` を render

### 3. テスト
`test/characterization/kejime/kejime-ramen-reset.test.ts`:
- ramen-reset: ramen_count が 0 に
- kejime_events に ramen_reset 記録 (ramen_delta=-N)
- current_points は変わらない
- adminAuth 必須 (401)

`test/characterization/kejime/kejime-article-manual-approve.test.ts`:
- pending を手動承認 → status='approved', -1pt
- rejected_fetch_error を手動承認 → -1pt
- 既に approved を再度承認 → 400 (二重承認防止)
- adminAuth 必須

## ファイル構成
- `src/routes/api/kejime.ts` (~80行追加: 2 endpoints + GET articles)
- `frontend/src/components/kejime/KejimeAdminTab.tsx` (新規 ~120行)
- `frontend/src/pages/action-detail/ActionMainContent.tsx` (~5行追加)
- テスト 2 ファイル (~200行)

## 制約 (厳守)
- **本体 200行以内 (テスト除外)**
- ブランチ: `feature/morning-kejime-pr6`
- PR タイトル: `feat(kejime): 激辛リセット API + admin UI (朝勉強会 PR6)`
- main 向け
- typecheck + 全テスト pass

## UI スケッチ

```
┌─ けじめポイント管理 ─────────────────────┐
│                                         │
│ ━━ 激辛ランキング ━━                    │
│  田中  🌶 ×2   [リセット]               │
│  佐藤  🌶 ×1   [リセット]               │
│                                         │
│ ━━ メンバー (内部pt / 表示pt / 🌶) ━━   │
│  山田   4 / 4 / 0                       │
│  鈴木   2 / 2 / 0                       │
│  田中   13 / 5 / 2                      │
│                                         │
│ ━━ 申請待ち記事 ━━                      │
│  山田: https://qiita.com/... [手動承認]│
│        body 234文字 (取得失敗だった)    │
│                                         │
│ ━━ 履歴 (直近20件) ━━                   │
│  2026-05-26 08:00 田中  late  +1pt      │
│  2026-05-25 12:30 山田  article -1pt    │
│  2026-05-24 18:00 田中  ramen_reset -2  │
└─────────────────────────────────────────┘
```

## 設計判断メモ

### ramen-reset で internal_points を触らない理由
ユーザー仕様: 「激辛解除は admin のみ操作可能」 — ramen の解除であって遅刻記録の解除ではない。
internal_points 自体を 0 にすると次の遅刻で再び 1pt スタートになり、過去の蓄積が失われる。
**ramen を 0 にするだけ** = 「激辛食べました」のリセット = 妥当。
internal_points を消したい場合は「免除」エンドポイント (PR3) で個別 late event を取り消す運用に誘導。

### article-manual-approve の必要性
PR5 で rejected_fetch_error が起きると pending にも入らず承認パスが死ぬ。
admin が手動で「これは正当な記事」と判断したら承認できる救済パスを残す。
将来的に Qiita 以外のドメイン (Zenn, note 等) を許可したい時の admin 救済としても機能。

### KejimeAdminTab の構成
1 ファイルに収めるため、各セクションは subcomponent を作らず flat に書く。
fetch は `useEffect` + `useState` で十分 (既存 RoleMainTab パターンを参考)。
スタイルは hitolink.css の `.btn-primary` `.btn-ghost` `.card` を使う。
