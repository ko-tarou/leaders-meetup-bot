# 004 メールテンプレート管理タブ追加

## 目的

member_application アクションに「メール」サブタブを追加し、複数のメールテンプレートを永続化できるようにする。

## 背景

現状の応募詳細モーダルには interview / passed / failed の 3 種が hardcoded されており、kota さんが新しい用途（フォーム送付、日程確定など）のテンプレを追加できない。

## データモデル

`event_actions.config` (member_application) に新フィールドを追加（マイグレーション不要）:

```jsonc
{
  "leaderAvailableSlots": [...],  // 既存
  "emailTemplates": [
    {
      "id": "uuid",
      "name": "最初の連絡",
      "body": "{name} 様\n..."
    }
  ]
}
```

プレースホルダ: `{name}`, `{email}`, `{studentId}`, `{interviewAt}`

## ファイル変更

| # | ファイル | 内容 | 行数目安 |
|---|---------|------|---------|
| 1 | `frontend/src/types.ts` | `EmailTemplate` 型を追加 | +5 |
| 2 | `frontend/src/components/EmailTemplatesEditor.tsx` (新) | テンプレ一覧 + 並び替え + 保存 UI | ~250 |
| 3 | `frontend/src/pages/ActionDetailPage.tsx` | サブタブに `email` 追加、render 分岐追加 | +15 |
| 4 | `frontend/src/components/MemberApplicationListTab.tsx` | hardcoded 3 種を削除し、保存テンプレ select に変更 | -50/+30 |

合計純増: 約 +250 行（200 行ガイドライン超過、新タブ + 新エディタ + 既存差替の最小単位）

## コミット分割

1. `feat(member-application): EmailTemplate 型定義を追加`
2. `feat(member-application): EmailTemplatesEditor コンポーネントを新設`
3. `feat(member-application): メールサブタブを ActionDetailPage に追加`
4. `feat(member-application): 応募詳細のメール欄を保存テンプレ select に変更`

## 互換性

- DB スキーマ無変更
- 既存 leaderAvailableSlots を持つ config は壊さない（JSON merge で保持）
- 既存 application データは何も変わらない
- 旧 hardcoded 3 種は削除されるが「デフォルトテンプレ例を追加」ボタンで復元可能

## 品質ゲート

- `npm run typecheck` 0 エラー
- `npm run build:frontend` 0 エラー

## ブランチ・PR

- ブランチ名: `feature/email-templates-tab`
- PR base: `main`
- PR タイトル: `feat(member-application): メールテンプレート管理タブを追加`
