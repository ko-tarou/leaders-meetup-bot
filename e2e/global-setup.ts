import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * E2E 前処理: ローカル D1 (.wrangler/state) に migration を適用し、
 * テストが前提にするイベント/アクションを冪等に seed する。
 * 毎回 INSERT OR REPLACE で上書きするため、前回実行の編集が残らず決定的。
 * 本番 D1 には一切触れない (--local のみ)。
 */
export default function globalSetup() {
  // stdio は inherit にする: 初回 CI は 70+ migration の適用ログが 1MB を超え、
  // pipe (デフォルト maxBuffer) だと ENOBUFS で落ちるため。
  const run = (cmd: string) =>
    execSync(cmd, { stdio: "inherit", cwd: join(__dirname, "..") });

  run("npx wrangler d1 migrations apply leaders-meetup-bot --local");

  const now = "2026-01-01T00:00:00.000Z";
  const amConfig = JSON.stringify({
    schemaVersion: 1,
    links: [
      { label: "表示コンテンツを編集", url: "/admin/cottage/content" },
      { label: "タイムテーブルを編集", url: "/admin/cottage" },
    ],
  }).replace(/'/g, "''");

  const sql = [
    `INSERT OR REPLACE INTO events (id,type,name,config,status,created_at) VALUES ('cottage','meetup','コテージ','{}','active','${now}');`,
    `INSERT OR REPLACE INTO event_actions (id,event_id,action_type,config,enabled,created_at,updated_at) VALUES ('e2e-am','cottage','app_management','${amConfig}',1,'${now}','${now}');`,
    `INSERT OR REPLACE INTO event_actions (id,event_id,action_type,config,enabled,created_at,updated_at) VALUES ('e2e-roster','cottage','member_roster','{}',1,'${now}','${now}');`,
    // add/delete 動線テスト用の type は毎回まっさらにする (schedule_polling を使う)。
    `DELETE FROM event_actions WHERE event_id='cottage' AND action_type='schedule_polling';`,
  ].join("\n");

  const dir = mkdtempSync(join(tmpdir(), "lmb-e2e-"));
  const file = join(dir, "seed.sql");
  writeFileSync(file, sql, "utf-8");
  try {
    run(`npx wrangler d1 execute leaders-meetup-bot --local --file ${file}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
