export type Env = {
  DB: D1Database;

  // 環境変数
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;

  // ADR-0006: workspaces.bot_token / signing_secret の AES-256-GCM 暗号化マスターキー
  // Base64 エンコードされた 32 バイト鍵（Wrangler secrets で管理）
  WORKSPACE_TOKEN_KEY: string;

  // ADR-0007: Slack OAuth v2 install フロー用
  // SLACK_CLIENT_ID / SLACK_CLIENT_SECRET は Slack App の Basic Information から取得
  // Wrangler secrets で管理（kota が手動で設定）
  SLACK_CLIENT_ID: string;
  SLACK_CLIENT_SECRET: string;
  // 例: https://<your-worker-domain>/slack/oauth/callback
  // wrangler.toml の vars または secret で設定
  OAUTH_REDIRECT_URL: string;

  // Cloudflare Workers Assets binding（SPA fallback で env.ASSETS.fetch から index.html を返す）
  ASSETS: Fetcher;

  // Sprint 20 PR1: email_inbox アクション用 webhook 認証トークン
  // POST /api/email-inbox/incoming に X-Webhook-Token ヘッダで送信される値と照合
  // Wrangler secrets で管理（kota が手動で設定）
  EMAIL_WEBHOOK_TOKEN: string;

  // Sprint 21 PR1: Gmail OAuth クライアント
  // GCP Cloud Console → API & Services → Credentials → "OAuth 2.0 Client IDs" で発行。
  // redirect URI には `<worker-origin>/google/oauth/callback` を登録する。
  // Wrangler secrets で管理（kota が手動で設定）
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
};
