# 002-5 weekly_reminder 一覧ベース UX 再構成 (Sprint 23 PR-A)

## 背景

現状: weekly_reminder アクションは「メイン」「設定」の 2 タブ構成。
設定タブを開くと N 個のリマインドが縦に巨大なフォームで全部展開されるため UX が悪い。

kota さんの要望:
> 初っ端に開いた画面に謎の設定項目を置かず、ただの一覧画面にしたい

## 目指す姿

```
weekly_reminder アクションを開く
└── リマインド一覧 (default landing) ← list page
    ├── + 新規追加 ボタン
    ├── リマインド「月曜朝」 → 詳細へ遷移
    ├── リマインド「月曜夜」 → 詳細へ遷移
    └── ...
        └── 詳細画面 (個別編集画面) ← detail page
            ├── （PR-A では暫定: 単一フォーム編集 = 旧 ReminderCard そのまま）
            └── PR-B で 3 タブ (チャンネル/時刻/テキスト) に分割予定
```

## このPR (PR-A) のスコープ

1. ルーティング変更: `/events/:eventId/actions/weekly_reminder/:reminderId` を新設
2. リマインド一覧画面の新設: `WeeklyReminderListPage`
3. 詳細画面の仮実装: `WeeklyReminderDetailPage` (既存 ReminderCard を流用、サブタブ無し)
4. 「+ 新規追加」「× 削除（確認ダイアログ）」「on/off スイッチ」の実装
5. 既存「メイン」「設定」タブ廃止
6. 旧 `WeeklyReminderForm` を削除

## スコープ外 (将来 PR)

- PR-B: 詳細画面のサブタブ化（チャンネル/時刻/テキスト）
- PR-C: チャンネル管理 UX 高度化
- attendance_check は触らない

## 変更ファイル一覧

| #   | ファイル                                            | 操作   | 行数目安 |
| --- | --------------------------------------------------- | ------ | -------- |
| 1   | `frontend/src/pages/WeeklyReminderListPage.tsx`     | 新規   | ~150     |
| 2   | `frontend/src/pages/WeeklyReminderDetailPage.tsx`   | 新規   | ~80      |
| 3   | `frontend/src/App.tsx`                              | 修正   | +5       |
| 4   | `frontend/src/pages/ActionDetailPage.tsx`           | 修正   | -30 / +15 |
| 5   | `frontend/src/components/WeeklyReminderForm.tsx`    | 削除   | -242     |

純増分: 約 +250 / -272 = -22 行（純減）。ファイル数は増える。

## 実装方針

### 共通ヘルパ

旧 `WeeklyReminderForm` 内にあった `parseConfig` / `toDraft` / `newReminder` ロジックは
詳細・一覧の両方で必要。
これらは新 `WeeklyReminderListPage.tsx` に移植して両ページから import する。

### `WeeklyReminderListPage`

仕様:

- props: `{ eventId, action }`
- 上部 + 新規追加 ボタン
- 0 件時: 空状態 UI 「リマインドが登録されていません」+ 「+ 新規追加」CTA
- リマインドカード（縦並び）:
  - リマインド名
  - サマリ行: `{曜日}曜 {時刻リスト} / {N}チャンネル / {message先頭30文字}...`
  - on/off スイッチ（即時保存）
  - × 削除ボタン（確認ダイアログ）
  - カード全体クリックで詳細画面へ遷移
  - on/off と × は `event.stopPropagation` でナビゲーション抑止
- 「+ 新規追加」: 新 reminder を作って配列に push → 保存 → 新 reminderId の詳細ページへ navigate

### `WeeklyReminderDetailPage`

仕様:

- URL: `/events/:eventId/actions/weekly_reminder/:reminderId`
- API で event_actions を fetch、weekly_reminder アクションを取得、config から該当 reminderId を抽出
- 該当 reminderId が無ければ「見つかりません」+ 一覧へ戻るリンク
- パンくず: ホーム / イベント / 週次リマインド / {reminder.name}
- 「← 一覧に戻る」ボタン
- メイン領域: 既存 `ReminderCard` を流用して 1 件分のフォーム表示
- 「保存」ボタン → 配列の該当 reminder を更新 → 保存 → トースト/alert → 詳細留まる

### `App.tsx`

- 既存 `/events/:eventId/actions/:actionType` の **上に** 追加:
  ```tsx
  <Route
    path="/events/:eventId/actions/weekly_reminder/:reminderId"
    element={<WeeklyReminderDetailPage />}
  />
  ```

### `ActionDetailPage`

- weekly_reminder の場合のみサブタブヘッダ非表示
- メインに `WeeklyReminderListPage` を直接レンダ
- 既存 `ActionMainContent` の `case "weekly_reminder"` 分岐を一覧ページ呼び出しに変更
- `ActionSettingsContent` の `case "weekly_reminder"` 分岐を削除
- `WeeklyReminderForm` / `WeeklyReminderMain` の import を削除
- 既存「無効化/削除」ボタンへの動線を維持するため、weekly_reminder では一覧ページ下部に
  アクション全体の「無効化/削除」ボタンを引き継ぐか、サブタブ非表示で困らないかは
  ActionDetailPage 内で判断する。
  → 一旦は: weekly_reminder のときは subTabs を空にしてヘッダ非表示、
     メイン領域に一覧 + (一覧の下部に) アクション全体の有効化/削除ボタンを残す。

## 互換性

- 既存 config の reminders 配列はそのまま読める（破壊的変更なし）
- 旧 UI で保存済みの設定は新 UI 一覧でカード表示される
- 空 config (`{}`) のレコードは「リマインドゼロ」状態の空状態 UI で表示

## 行数 / コミット規約

- 200 行ガイドライン超過の可能性あり、超過時は PR 本文で経緯説明
- 1 コミット 50 行目安、4 コミット程度に分割:
  1. `feat(weekly-reminder): 一覧ページコンポーネントを新設`
  2. `feat(weekly-reminder): 詳細ページコンポーネントを新設（暫定単一フォーム）`
  3. `feat(weekly-reminder): ルーティングと ActionDetailPage を一覧/詳細構造に変更`
  4. `chore(weekly-reminder): 旧 WeeklyReminderForm を削除`

## 品質ゲート

- `npm run typecheck`
- `npm run build:frontend`
両方 0 エラー。

## ブランチ / PR

- branch: `feature/weekly-reminder-list-ux`
- base: `main`
- title: `feat(weekly-reminder): 一覧ベース UX に再構成 (Sprint 23 PR-A)`
