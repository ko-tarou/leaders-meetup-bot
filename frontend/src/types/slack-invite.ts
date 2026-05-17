// 005-slack-invite-monitor: 応募完了メール等に埋め込む Slack 招待リンク + 有効性監視設定。
// event_actions.config.slackInvites (配列) に保存される。
//
// 複数登録対応: 1 action に N 件の招待リンクを登録できる。
//   - メール本文の {slackInviteLink} placeholder は全 URL を改行区切りで render
//   - 監視 cron は invite 単位で独立に状態管理
//
// - id:   UI key 用 (crypto.randomUUID()) + BE 状態管理用
// - name: 表示名 (例: "DevelopersHub")。空なら "Slack" 扱い。
// - url:  招待リンク本体
// - monitor* : 1 日 1 回 BE cron でリンクを GET し、無効化遷移時に Slack 通知する設定。
// - lastCheckedAt / lastStatus / lastNotifiedAt: BE が cron で書き換える運用フィールド。
//   FE では参照のみ (read-only)、保存時に渡しても BE で上書きされる前提。
//
// 後方互換: 旧 config.slackInvite (単数オブジェクト) は BE / FE 双方の parser で
//   配列化される (id auto-gen, name="Slack")。
export type SlackInvite = {
  id: string;
  name: string;
  url?: string;
  monitorEnabled?: boolean;
  monitorWorkspaceId?: string;
  monitorChannelId?: string;
  monitorChannelName?: string;
  monitorMentionUserIds?: string[];
  lastCheckedAt?: string;
  lastStatus?: "valid" | "invalid";
  lastNotifiedAt?: string;
};

/** @deprecated 旧名称 (単数オブジェクト前提)。SlackInvite を使用すること。 */
export type SlackInviteConfig = SlackInvite;
