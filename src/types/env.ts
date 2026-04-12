export type Env = {
  DB: D1Database;

  // 環境変数
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
};
