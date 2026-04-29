export type Env = {
  DB: D1Database;

  // 環境変数
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;

  // ADR-0006: workspaces.bot_token / signing_secret の AES-256-GCM 暗号化マスターキー
  // Base64 エンコードされた 32 バイト鍵（Wrangler secrets で管理）
  WORKSPACE_TOKEN_KEY: string;
};
