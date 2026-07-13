# ADR-0011: channel_router (HackIT Slack チャンネル自動振り分け)

- Status: Accepted (PR1: ルール表 + 手動同期 + ドライランまで)
- Date: 2026-07-14

## Context

HackIT の Slack ワークスペースには開催が近づくにつれ参加者・運営が続々と join する。
現在は「誰が入ってきたか」を人が目視で確認し、役割に応じたチャンネルへ手動で招待している。

- 参加者 -> 参加者用チャンネルへ
- 運営 -> 運営名簿の役割に応じたチャンネルへ

これを自動化したい。lmb には既に以下の基盤がある:

- **multi-workspace**: `workspaces` テーブル (暗号化 bot token) + `createSlackClientForWorkspace`。
  HackIT ワークスペース (team `T08GLF7QHDG`) は登録済みで、HackIt 2026 イベントの
  role_management が `config.workspaceId` で参照して sync 実績あり。
- **運営名簿**: role_management (`slack_roles` / `slack_role_members`)。
- **invite 基盤**: `conversationsInviteBulk` / role-sync (次フェーズで再利用)。

## Decision

### 1. 新 action type `channel_router` (event 配下・ADR-0008 準拠)

- 表示名「チャンネル自動振り分け」。sub-tab は「メイン / 振り分けルール / その他設定」。
- `config = { schemaVersion: 1, workspaceId }`。workspaceId は role_management と同じ規約。

### 2. 役割判定 = 運営名簿 (role_management) と照合

- **同一イベントの role_management 配下 `slack_roles` にメンバー登録がある人 = 運営**。
  保有ロールに紐づくルールのチャンネル (和集合) へ振り分ける。
- **名簿に居ない人 = 参加者 (デフォルト仮説)**。participant ルールのチャンネルへ。
  HackIT は運営が名簿管理されており、名簿外 join は参加者とみなせるため。
  例外 (スポンサー等) は「対象外にする」で個別に外せる。
- マッチするルールが無い場合は reason 付きで「振り分け先なし」を表示する (黙って skip しない)。
- role_management が `sharedFromActionId` を持つ場合は共有元の roles を参照 (roles.ts と同じ)。

### 3. テーブル (migration 0090)

- `channel_router_rules`: 対象 (role_id or participant) x channel_id。1 対応 = 1 行。
  式 UNIQUE `(event_action_id, target_kind, coalesce(role_id,''), channel_id)`。
- `channel_router_members`: 検出済みメンバーのスナップショット。
  status = `pending` (未振り分け) / `ignored` (対象外) / `routed` (招待済み・次フェーズが付与)。
- migration 番号は並行開発 (gantt 0077+) との衝突回避のため 0090 に飛ばした。

### 4. メンバー検出 = 手動同期 (users.list) から始める

- PR1 は「メンバーを同期」ボタンで `users.list` を取得し、bot/deleted を除いて upsert。
  読み取り (users:read) のみで、既存トークンで追加設定なしに動く。
- `team_join` イベントでのリアルタイム検出は次フェーズ。HackIT 側 Slack App の
  Event Subscriptions に `team_join` を足す必要がある (ユーザー作業)。

### 5. PR1 はドライランまで。実招待はしない

- 「ドライランを実行」= 計画 (誰をどこへ) の計算・表示のみ。Slack へは一切書き込まない。
- 「招待を実行」ボタンは disabled (coming soon) で置く。API `/execute` は 501。
- 次フェーズで `conversationsInviteBulk` を使い実行 + `routed` への遷移を実装する。
  必要 scope: public は `channels:manage`、private は `groups:write` (HackIT bot token に要確認)。

## Alternatives Considered

- **member_welcome の拡張**: 既存の「新メンバー対応」は member_joined_channel 起点で
  単一チャンネル招待 + DM の固定フロー。役割別ルール表・ドライランという別物の UX を
  混ぜるより、独立 action の方が (event_id, action_type) UNIQUE 上も干渉しない。
- **参加者判定を招待リスト/フォームと突合**: 参加登録データとの突合はより正確だが、
  データソースが未確定。名簿外 = 参加者のデフォルト仮説で開始し、必要になれば
  participation_forms との突合を追加する。
- **即・実招待まで実装**: 誤設定で数百人を誤チャンネルへ入れる事故リスクがあるため、
  ルール表 + ドライランで設定を確認できる状態を先に作る (段階導入)。

## Consequences

- 運営はルール表を一度作れば、同期 -> ドライラン -> (次フェーズ) 実行の 3 手で振り分け完了。
- `routed` の付与を次フェーズに残したため、それまで振り分け済みメンバーは
  「対象外にする」で手動整理するか pending のままになる。
- role ルールは slack_roles に ON DELETE CASCADE。ロール削除でルールも消える (孤児ルールなし)。
