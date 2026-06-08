# 002 Sprint 23: 週次リマインド + 出席確認

## 概要

定例ミーティング運用で「リマインドが見落とされる」「出欠が事前に分からない」課題に対し、
2 つのアクションを追加する施策。並列 2 エージェントで PR を分割。

## PR 一覧

| PR  | 内容                       | ブランチ                     | 状態     |
| --- | -------------------------- | ---------------------------- | -------- |
| #1  | weekly_reminder アクション | feature/weekly-reminder      | merged   |
| #2  | attendance_check アクション | feature/attendance-check     | 着手中   |

---

## PR #2 attendance_check (このエージェント担当)

詳細は `002-2_attendance_check.md` 参照。

### スコープ

- 月曜朝 9:00 頃にチャンネルへ「出席しますか？」アンケートを post
- ボタン (出席/欠席/未定) で投票 → 集計はチャンネル全体に出すが個別回答は ephemeral
- 締切時刻に集計を post
- 1 アクションで朝会・夜会など複数 poll を 1 日に出せる (polls 配列)

### キーポイント

- **匿名性**: 投票本人だけ ephemeral 経由で自分の選択を確認可能
- **DM ではなくチャンネル post**: 全員に届いていることを目視できる
- 結果集計は出席 N / 欠席 N / 未定 N の数字のみ (個人名は出さない)

### 新規ファイル

- `migrations/0027_attendance_polls.sql`
- `src/services/attendance-check.ts`
- `frontend/src/components/AttendanceCheckForm.tsx`

### 変更ファイル

- `migrations/meta/_journal.json` (entry 追加)
- `src/db/schema.ts` (attendance_polls / attendance_votes 追加)
- `src/services/slack-blocks.ts` (poll/result blocks ヘルパ追加)
- `src/routes/slack.ts` (interactivity 分岐追加)
- `src/routes/api.ts` (VALID_TYPES に attendance_check 追加)
- `src/index.ts` (scheduled に processAttendanceCheck 追加)
- `frontend/src/types.ts` (EventActionType 拡張)
- `frontend/src/lib/eventTabs.ts` (ACTION_META 追加)
- `frontend/src/components/ActionsListView.tsx` (ALL_ACTION_TYPES 追加)
- `frontend/src/pages/ActionDetailPage.tsx` (switch に分岐追加)
