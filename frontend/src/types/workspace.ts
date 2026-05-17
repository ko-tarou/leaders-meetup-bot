// Slack workspace（ADR-0006）
// bot_token / signing_secret は backend が返さないため型にも含めない
export type Workspace = {
  id: string;
  name: string;
  slackTeamId: string;
  createdAt: string;
};
