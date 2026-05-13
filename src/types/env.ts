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

  // 005-1: admin API 認証用 Bearer トークン
  // Wrangler secrets で管理（kota が手動で設定: `npx wrangler secret put ADMIN_TOKEN`）
  // 未設定の場合、保護対象 API は 500 を返す。
  ADMIN_TOKEN: string;

  // Sprint 26: Google OAuth (Gmail API) credentials。
  // GCP Console で作成した OAuth 2.0 client の値を `wrangler secret put` で設定する。
  // 未設定の場合、Gmail OAuth install endpoint は 500 を返す (fail closed)。
  //
  // Authorized redirect URI (GCP Console 側に登録必須):
  //   https://leaders-meetup-bot.akokoa1221.workers.dev/api/google-oauth/callback
  //   http://localhost:8787/api/google-oauth/callback   # ローカル開発時
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;

  // 005-feedback: Gemini 1.5 Flash の API key。
  // フィードバックウィジェットの「使い方を聞く (AI)」タブから呼び出す。
  // 未設定の場合、/api/feedback/ai-chat は 500 を返す。
  // `npx wrangler secret put GEMINI_API_KEY` で設定済。
  GEMINI_API_KEY: string;

  // 005-github-webhook: GitHub webhook の HMAC-SHA256 検証用 shared secret。
  // GitHub 側 (repo Settings → Webhooks) で同じ値を Secret 欄に登録する。
  // 未設定の場合 /api/github-webhook は 503 を返して webhook を一時無効化する。
  // `wrangler secret put GITHUB_WEBHOOK_SECRET` で設定する。
  GITHUB_WEBHOOK_SECRET: string;
};
