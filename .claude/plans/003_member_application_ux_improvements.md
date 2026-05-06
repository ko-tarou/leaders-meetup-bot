# 003 member_application UX 改善

## 背景

DevelopersHub 運営の **新メンバー入会アクション (member_application)** に対する kota さんのフィードバック 3 点を解消する。

## スコープ

1. **面談確定日時の選択 UI 化**
   - `MemberApplicationListTab.tsx` の詳細モーダル
   - `<input type="datetime-local">` 手入力 → 希望日時リストをクリック選択
   - 選択中スロットはハイライト、再クリックで解除
   - 旧データ等で interviewAt が希望リスト外の場合は注意表示 + 解除ボタン
2. **志望動機 / 自己紹介セクションの削除**
   - 旧フォーム残骸の表示を詳細モーダルから削除
   - DB カラムは保持（マイグレーション無し）
3. **確定済み枠の候補制御**
   - `/apply/:eventId/availability` で `applications.interviewAt` を集計
   - `leaderAvailableSlots` から確定済み slot を除外して返す
   - レスポンス契約は変えない

## 実装プラン

### コミット 1: 面談確定日時を希望日時クリック選択に変更

**ファイル:** `frontend/src/components/MemberApplicationListTab.tsx`

- 既存「希望日時 (N枠)」と「面談確定日時」の 2 セクションを統合
- ラベル: `面談確定日時 (希望日時から選択)`
- 各 slot を Button-like カードで表示
  - 通常: グレー枠 + 白背景 + cursor pointer
  - ホバー: 枠を濃く（`onMouseEnter` / `onMouseLeave` で state 切替 or CSS）
  - 選択中: 青枠 + `background: #2563eb` + `color: white` + 「✓」マーク
  - クリック: `setInterviewAt(slot)` / 同じ slot 再クリックで `setInterviewAt("")`
- 候補なし時: 従来通り「（希望日時なし）」表示
- interviewAt が slots に含まれない（旧データ等）の場合:
  - リスト下に注意付き表示 + 解除ボタン
- 下部に小さくヒント文

### コミット 2: 旧フォーム志望動機 / 自己紹介セクション削除

**ファイル:** `frontend/src/components/MemberApplicationListTab.tsx`

- 「志望動機」「自己紹介」の `<Section>` を削除（line 401-413）
- 後方互換コメント（line 401-402）も削除
- `application.motivation` / `application.introduction` の参照は **メールテンプレ等含めて存在しないので**完全に表示無し。型は維持。

### コミット 3: 確定済み slot を新規応募候補から除外

**ファイル:** `src/routes/api.ts`

- `import { eq, and, inArray }` に `isNotNull` を追加
- `/apply/:eventId/availability` のロジックに以下を追加:
  - `applications` テーブルから当該 eventId かつ `interviewAt IS NOT NULL` のレコードを取得
  - 取得 interviewAt の Set を構築
  - `leaderAvailableSlots` を filter（booked Set に含まれない slot のみ残す）
- レスポンス JSON 構造は変更なし

## 行数見積もり

| ファイル | 削除 | 追加 |
|---------|------|------|
| MemberApplicationListTab.tsx | -30 | +50 |
| src/routes/api.ts | 0 | +15 |
| **合計** | -30 | +65 |

200 行ガイドライン以内。

## 品質ゲート

- `npm run typecheck` 0 エラー
- `npm run build:frontend` 0 エラー
- DB マイグレーション無し
- API レスポンス契約不変

## レビュー観点

1. **DB アーキテクト視点**: applications テーブル全件 select は eventId フィルタ + 必要カラムのみで N+1 にならないか
2. **Security 視点**: `/apply/:eventId/availability` は public エンドポイント。他応募者の interviewAt（個人情報的属性）を間接的に露出しないか → slot 文字列のみで PII は含まれないので OK
3. **UX/Designer 視点**: クリック式選択 UI のアフォーダンス（カードがクリック可能と分かる視覚表現）

## 互換性

- DB スキーマ無変更
- 公開フォーム (`PublicApplyPage`) は API レスポンス形が同じなので無変更
- 既存応募データ（旧フォームの motivation/introduction を持つもの）は admin 画面で表示されなくなるが DB には残る
