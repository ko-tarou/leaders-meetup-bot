# DevHub Ops 拡張 全体計画

## ゴール
- リーダー雑談会専用Botを Developers Hub 全体の運営支援プラットフォームへ拡張
- HackIt（年次ハッカソン）のタスク管理機能を追加
- 既存リーダー雑談会の運用を一切壊さない

## 関連ADR
- [ADR-0001 イベントモデル](https://github.com/ko-tarou/leaders-meetup-bot/pull/32)
- [ADR-0002 タスク管理](https://github.com/ko-tarou/leaders-meetup-bot/pull/33)
- [ADR-0003 UIイベントスイッチャー](https://github.com/ko-tarou/leaders-meetup-bot/pull/35)
- [ADR-0004 アプリ名変更 DevHub Ops](https://github.com/ko-tarou/leaders-meetup-bot/pull/34)
- [ADR-0005 データマイグレーション](https://github.com/ko-tarou/leaders-meetup-bot/pull/36)

## Sprint 構成

### Sprint 1: 基盤（events 導入、4 PR、順次）
| # | PR | 内容 | 依存 |
|---|----|------|------|
| 1 | events スキーマ + 初期マイグレーション | Drizzle schema.ts に events テーブル追加 + drizzle/NNNN_add_events.sql 生成 | - |
| 2 | meetings.event_id 追加 + デフォルトイベント挿入 + バックフィル | ADD COLUMN event_id, INSERT default event, UPDATE meetings | PR1 |
| 3 | events API CRUD | /api/events GET/POST/PUT/DELETE | PR1 |
| 4 | meetings API 拡張 | event_id 受付、未指定時は default event にフォールバック | PR2, PR3 |

### Sprint 2: UI切替（3 PR、順次）
| # | PR | 内容 | 依存 |
|---|----|------|------|
| 1 | event スイッチャー UI コンポーネント + types | ヘッダードロップダウン、event 選択状態管理 | Sprint1 |
| 2 | URL ルーティング `/events/:eventId/:tab` | React Router 構造変更 | PR1 |
| 3 | 空状態 / 無効ID時のフォールバック | events 0件、ID失効、tab型不整合の対応 | PR2 |

### Sprint 3: タスク基盤（5 PR、最大3並列）
| # | PR | 内容 | 依存 | 並行可 |
|---|----|------|------|------|
| 1 | tasks + task_assignees スキーマ + マイグレーション | Drizzle schema + 初期migration | Sprint1 | A |
| 2 | tasks API CRUD | /api/tasks GET/POST/PUT/DELETE + フィルタ | PR1 | B |
| 3 | task_assignees API | アサイン追加/削除 | PR1 | B |
| 4 | Slack /devhub task add コマンド + モーダル | コマンド受付、モーダル送信、create | PR2 | C |
| 5 | Slack /devhub task list + 完了ボタン + リマインドジョブ | list表示、Block Actions、scheduled_jobs登録 | PR2, PR3 | - |

### Sprint 4: タスクUI（3 PR、並列可）
| # | PR | 内容 | 依存 | 並行可 |
|---|----|------|------|------|
| 1 | タスク一覧画面 | hackathon タブのリスト表示 | Sprint3 | A |
| 2 | タスクフィルタ UI | status/assignee/due/priority/親子 | PR1 | A |
| 3 | タスク作成・編集モーダル | フォーム入力 + API呼び出し | Sprint3 | A |

### Sprint 5: リネーム（1 PR、単独）
| # | PR | 内容 | 依存 |
|---|----|------|------|
| 1 | DevHub Ops 改名 | package.json / wrangler.toml(name+database_name) / scripts / README / frontend title | 全Sprint完了後 |

## 既存リーダー雑談会を壊さない安全策
1. **追加のみ・削除しない**: 既存テーブル・API・Slackコマンド (`/meetup`) は一切変更しない
2. **フォールバック**: event_id 未指定時は default meetup event に紐付け
3. **CIゲート**: 各PRで `pnpm typecheck` + `pnpm lint` + `pnpm build` を必須化、失敗したらPR出さない
4. **デプロイ手動**: エージェントは push のみ、本番反映は kota が `pnpm deploy`
5. **段階マイグレーション**: ADR-0005 の3段階（追加→バックフィル→強制化）に従う

## 進捗トラッキング
| Sprint | 状態 | 開始日 | 完了日 | メモ |
|---|---|---|---|---|
| 1 | 進行中 | 2026-04-29 | - | PR1から起動 |
| 2 | 未着手 | - | - | - |
| 3 | 未着手 | - | - | - |
| 4 | 未着手 | - | - | - |
| 5 | 未着手 | - | - | - |

## 注意事項
- **1 PR ≤ 200行**、超えそうなら分割相談
- **1エージェント = 1 PR**
- **コミット 50行/個** が目安
- ブランチ命名: `feature/sprint-N-prM-<slug>` 形式
- worktree隔離必須（並列時）
- 各PR提出時にPRテンプレート（あれば）に従う
