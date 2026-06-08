# 005 ハードニング スプリント（リファクタ専用）

## 背景

multi-review (2026-05-07) で挙がった 36 件 [must] / 22 件 [suggestion] に対する集中対応。
新機能追加は 0、品質改善のみ。

## 優先順位とフェーズ

### Phase 1 (P0): 即直すべき土台
| PR | 内容 | 依存 | 工数 | 担当エージェント |
|---|---|---|---|---|
| 005-1 | **API 認証導入** — admin Bearer or Cloudflare Access。`/api/*` を保護、CORS allowlist 化。`x-admin-token` header 検証ミドルウェア + 環境変数 `ADMIN_TOKEN`。FE は `localStorage` 経由でトークン保持、初回プロンプト UI | なし | 大 (200行) | Agent-A |
| 005-2 | **APIError 導入 + res.ok チェック** — `frontend/src/api.ts` の `request<T>` を `if (!res.ok) throw new APIError(...)` に。エラーハンドラの粒度を上げる | なし | 小 (50行) | Agent-B |

### Phase 2 (P1): データ整合性
| PR | 内容 | 依存 | 工数 | 担当エージェント |
|---|---|---|---|---|
| 005-3 | **weekly-reminder / auto-cycle の冪等性統一** — `scheduled_jobs` に `status` 列 (pending/completed/failed) + dedupKey の意味を「failed 時はリトライ可」に再定義。post 失敗時に永久消失しないように | なし | 中 (150行) | Agent-C |
| 005-4 | **meetings.channelId UNIQUE + 必要 index 追加** — migration 0028。`(workspace_id, channel_id)` UNIQUE。`tasks.eventId`, `prReviews.eventId`, `polls.meetingId`, `scheduled_jobs(status, next_run_at)` 等の index | なし | 中 (100行) | Agent-D |
| 005-5 | **LGTM / task assignees / poll vote の atomic 化** — drizzle batch でラップ。LGTM 二重通知 (#27)、task assignees 部分挿入 (#26)、poll vote 二連打 (#11) を一括対応 | 005-4 後（UNIQUE 前提が活きるため） | 大 (200行) | Agent-E |

### Phase 3 (P2): 重複削除 + デザイン基盤
| PR | 内容 | 依存 | 工数 | 担当エージェント |
|---|---|---|---|---|
| 005-6 | **Sticky Board 抽象化** — `src/services/sticky-board-base.ts` を作って sticky-task-board / sticky-pr-review-board の 800 行コピーを共通化。buildBlocks のみ差し替え | なし | 大 (200行) | Agent-F |
| 005-7 | **FE デザイントークン + 共通 Button / Toast / ConfirmDialog** — `frontend/src/styles/tokens.ts` でカラー統一 + `<Button>` `<Toast>` `<ConfirmDialog>` の 3 コンポーネント新設。既存 alert/confirm は最小限置き換え（一括置換は別 PR） | なし | 中 (200行) | Agent-G |
| 005-8 | **alert/confirm 一括置換** | 005-7 完了後 | 中 (200行) | Agent-H |
| 005-9 | **ScheduleSection.tsx 分割**（649 行 → 3-4 ファイル）+ ESLint deps disable 撤去 | なし | 中 (200行) | Agent-I |
| 005-10 | **PRReviewListTab.tsx 分割**（636 行 → 3 ファイル） | なし | 中 (200行) | Agent-J |
| 005-11 | **Pagination + ChannelPicker 共通コンポーネント抽出** | 005-7 後 | 中 (150行) | Agent-K |

### Phase 4 (P3): god file 分割
| PR | 内容 | 依存 | 工数 | 担当エージェント |
|---|---|---|---|---|
| 005-12 | **`src/routes/api.ts` 分割** — Hono `.route()` で `routes/api/tasks.ts`, `pr-reviews.ts`, `meetings.ts`, `applications.ts`, `oauth.ts` 等に分離。中身は変更しない（純粋な分割） | なし | 大 (純移動 200行) | Agent-L |
| 005-13 | **`src/routes/slack.ts` 分割** + view_submission の重複削除 (#32) + SlackClient ハードコード解消 (#34) | 005-12 完了後 | 大 (200行) | Agent-M |

## 実行戦略

- **Phase 1（005-1, 005-2）は並行 2 エージェント**: 独立性高い、worktree isolation 必須
- **Phase 2（005-3, 005-4, 005-5）は順次（005-5 のみ 005-4 依存）**: 005-3 と 005-4 は並行可
- **Phase 3 は独立性高いので 3 並行可**: ただし 005-8 と 005-11 は 005-7 後
- **Phase 4 は順次**

## ルール

- 各 PR は **main 向け、200 行以内**
- 各 worktree で完結、互いに干渉しない
- PR ごとにビルド・型チェックを通す
- マージ後は次の Phase に進む前に動作確認

## 残・スコープ外

以下は今回のスプリントには含めない:
- N+1 (#15, #16) — BE batch endpoint 設計を要する、別スプリント
- 絵文字 → アイコンライブラリ移行 (#63) — 工数大、優先度低
- meetings god table 分割 (#18) — マイグレーション影響大、別 ADR 必須
- legacy `reminderDaysBefore` drop (#19) — マイグレーション + コード両方
- アクション命名の編集可否（前会話で kota が検討中の項目）

## 完了判定

- 36 件 [must] のうち最低 30 件以上を解消
- 全 PR が main に merge され、本番デプロイで regression なし
- multi-review を再実施して [must] が 5 件以下になる
