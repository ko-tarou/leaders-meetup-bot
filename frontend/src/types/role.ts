// ロール管理 (Sprint 24 / role_management)
//
// 概念:
//   role_management action: event_actions.config = { workspaceId: string }
//   slack_roles:           action 配下の「ロール」(例: tech-lead, mentor)
//   slack_role_members:    role × Slack user の中間
//   slack_role_channels:   role × Slack channel の中間
//
// FE では一覧 API のレスポンスに membersCount / channelsCount が同梱される。
// (BE 側で Promise.all して計算するので追加 round-trip は不要)
export type SlackRole = {
  id: string;
  name: string;
  description: string | null;
  // 親ロール (子ロールのメンバー ⊆ 親ロールのメンバー)。ルートは null。
  parentRoleId: string | null;
  membersCount: number;
  channelsCount: number;
  createdAt: string;
  updatedAt: string;
};

// GET /roles/:roleId/members → { slackUserId, addedAt }[]
export type SlackRoleMemberRow = {
  slackUserId: string;
  addedAt: string;
};

// GET /roles/:roleId/channels → { channelId, addedAt }[]
export type SlackRoleChannelRow = {
  channelId: string;
  addedAt: string;
};

// GET /workspace-members → SlackUser[]
//
// ChannelPicker の SlackChannelLike と並列の position に立つ「Slack ユーザの軽量表現」。
export type SlackUser = {
  id: string;
  name: string;
  realName?: string;
  displayName?: string;
  imageUrl?: string;
};

// 命名規則ベースの自動分類 (classify-preview)。
// BE: GET /orgs/:eventId/actions/:actionId/classify-preview
export type RoleCategory = "participant" | "staff" | "sponsor" | "judge";

export type ClassifiedMember = {
  id: string;
  displayName: string;
  category: RoleCategory | null;
  categoryLabel: string | null;
  matchedLabel: string | null;
  // 名簿 (member_roster) に載っているか。
  inRoster: boolean;
  // gated カテゴリ (運営/スポンサー) だが名簿に無い = 誤爆候補。
  needsReview: boolean;
};

export type ClassificationSummary = {
  total: number;
  byCategory: Record<RoleCategory, number>;
  unclassified: number;
  needsReview: number;
};

export type ClassifyPreviewResponse = {
  workspaceId: string;
  rosterActionFound: boolean;
  summary: ClassificationSummary;
  members: ClassifiedMember[];
};

// 1 channel あたりの sync diff (期待 vs 現状)。
// BE の ChannelSyncDiff (src/services/role-sync.ts) と同型。
// error が入っているときは toInvite/toKick は空でも UI 側で「取得失敗」表示する。
export type ChannelDiff = {
  channelId: string;
  channelName: string;
  toInvite: string[];
  toKick: string[];
  error?: string;
};

// GET /sync-diff のレスポンス全体
export type SyncDiffResponse = {
  workspaceId: string;
  channels: ChannelDiff[];
  // offset/limit ページング時のみ設定される。全件計算 (offset/limit 未指定) では
  // undefined。nextOffset が null になるまでフロントが offset を辿って連結する。
  total?: number;
  nextOffset?: number | null;
};

// POST /sync の結果
export type SyncResult = {
  invited: number;
  kicked: number;
  errors: {
    channelId: string;
    action: "invite" | "kick" | "fetch_members";
    userId?: string;
    users?: string[];
    error: string;
  }[];
  // subrequest 予算内で処理し切れず次リクエストに持ち越した operation 群。
  // フロントはこれが空になるまで再送する (大規模チャンネル/大量 kick 対策)。
  deferred?: { channelId: string; invite: boolean; kick: boolean }[];
};

// 005-user-oauth: POST /bot-bulk-invite の結果。
//   admin user の user_access_token で取得した全 channel に対して
//   bot を invite した結果サマリ。
//   - totalChannels: user token で見えた channel 数 (archived は除外)
//   - alreadyMember: 既に bot が member だった channel
//   - invited: 新規 invite 成功
//   - failed: invite 失敗 (errors[] に詳細)
export type BotBulkInviteResult = {
  totalChannels: number;
  alreadyMember: number;
  invited: number;
  failed: number;
  errors: { channelId: string; channelName?: string; error: string }[];
  // 残りがある場合は次回の offset。null なら全件処理完了。
  // Cloudflare Workers subrequest 上限の制約で 1 invocation あたり 35 channel
  // までしか invite しないため、frontend で nextOffset を辿って累積処理する。
  nextOffset: number | null;
};
