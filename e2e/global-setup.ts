import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * migration ファイルから seed の INSERT 文 (単一行) を抜き出す。
 * cottage のタイムテーブル / 表示コンテンツの「サンプルデータ プリロード」を
 * E2E で検証するため、毎回 DELETE -> この INSERT を再実行して
 * ローカル D1 を migration seed と同値に戻す (決定的・過去の編集が残らない)。
 */
function seedInsertsFrom(migrationFile: string): string {
  const src = readFileSync(
    join(__dirname, "..", "migrations", migrationFile),
    "utf-8",
  );
  return src
    .split("\n")
    .filter((l) => l.startsWith("INSERT"))
    .join("\n");
}

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
  // 出席ダッシュボードの日付入力は「今日 (JST)」が既定・上限なので、遡及修正 E2E の
  // seed (late 出席行 / penalty) は実行時の JST 今日で作る。
  const todayJst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

  // 応募フォーム自動保存 E2E 用の面談候補 slot。
  // WeekCalendarPicker は cell を「その JST 暦日 の hh:mm を toISOString した UTC」
  // で表すため、seed 値も同じ規則で生成する (テストは timezoneId=Asia/Tokyo で実行)。
  // 「翌日 12:00 JST」= 常に未来 かつ 当該週/翌週 に入るので、spec 側で週送りして拾える。
  const jstShift = new Date(Date.now() + 9 * 3600 * 1000);
  const applySlotUtc = new Date(
    Date.UTC(
      jstShift.getUTCFullYear(),
      jstShift.getUTCMonth(),
      jstShift.getUTCDate() + 1,
      12 - 9, // 12:00 JST → 03:00 UTC
      0,
      0,
      0,
    ),
  ).toISOString();
  const applyConfig = JSON.stringify({
    schemaVersion: 1,
    leaderAvailableSlots: [applySlotUtc],
  }).replace(/'/g, "''");
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
    // channel_router を「+新規追加」モーダルから追加する再現テスト用。毎回まっさらに
    // して cottage には未登録の状態から始める (モーダルが選択肢に出す前提)。
    `DELETE FROM event_actions WHERE event_id='cottage' AND action_type='channel_router';`,
    // サンプルデータ プリロード検証用:
    // - タイムテーブルは決定的な 2 日/3 項目の fixture に毎回リセット
    //   (0074 の seed は INSERT...SELECT で旧テーブル依存のため直接は再実行できない)。
    // - 表示コンテンツは migration 0075 の seed (SampleData.swift と同値) に毎回リセット。
    `INSERT OR REPLACE INTO timetable_events (id,name,start_date,end_date,description,data,created_at,updated_at) VALUES ('cottage','瀬女コテージ','2026-08-06','2026-08-07','','${JSON.stringify({
      days: [
        { day: 1, date: "2026-08-06", items: [
          { id: "d1-1", start: "10:00", end: "12:00", title: "集合・移動", location: "", note: "" },
          { id: "d1-2", start: "18:00", end: "20:00", title: "BBQ", location: "BBQ場", note: "" },
        ] },
        { day: 2, date: "2026-08-07", items: [
          { id: "d2-1", start: "09:00", end: "10:00", title: "朝食", location: "", note: "" },
        ] },
      ],
    }).replace(/'/g, "''")}','${now}','${now}');`,
    `DELETE FROM cottage_content WHERE id='cottage';`,
    seedInsertsFrom("0075_cottage_content.sql"),
    // けじめ管理タブ (申請待ち + 申請履歴) 検証用。件数アサートを決定的にするため
    // action 配下の申請/メンバーを毎回リセットして 2 件 (pending / approved) にする。
    // config.roleId は出席遡及修正 / 除名 E2E 用の朝活名簿 (e2e-role) を指す。
    `INSERT OR REPLACE INTO event_actions (id,event_id,action_type,config,enabled,created_at,updated_at) VALUES ('e2e-kejime','cottage','kejime_tracker','{"schemaVersion":1,"roleId":"e2e-role"}',1,'${now}','${now}');`,
    `DELETE FROM kejime_article_requests WHERE event_action_id='e2e-kejime';`,
    `DELETE FROM kejime_members WHERE event_action_id='e2e-kejime';`,
    `INSERT INTO kejime_members (id,event_action_id,slack_user_id,display_name,current_points,ramen_count,created_at,updated_at) VALUES ('e2e-km1','e2e-kejime','UE2E0001','E2Eメンバー',2,0,'${now}','${now}');`,
    `INSERT INTO kejime_article_requests (id,event_action_id,member_id,qiita_url,body_length,status,created_at) VALUES ('e2e-ar-pending','e2e-kejime','e2e-km1','https://qiita.com/e2e/items/pending1',600,'pending','${now}');`,
    `INSERT INTO kejime_article_requests (id,event_action_id,member_id,qiita_url,body_length,status,decided_by,decided_at,created_at) VALUES ('e2e-ar-approved','e2e-kejime','e2e-km1','https://qiita.com/e2e/items/approved1',800,'approved','admin','${now}','${now}');`,
    // 出席の遡及修正 (欠席<->出席) + 激辛 3 杯除名 E2E 用 seed。
    // - e2e-morning: 出席ダッシュボード (morning_standup)。名簿は e2e-role。
    // - E2E遅刻者 (UE2E0002): 今日 late + ガチャ抽選済み 2pt (open penalty)。
    // - E2E激辛者 (UE2E0003): 0pt。edit-points で 15pt に上げ除名を発火させる。
    `INSERT OR REPLACE INTO event_actions (id,event_id,action_type,config,enabled,created_at,updated_at) VALUES ('e2e-morning','cottage','morning_standup','{"schemaVersion":1,"roleId":"e2e-role"}',1,'${now}','${now}');`,
    `INSERT OR REPLACE INTO slack_roles (id,event_action_id,name,created_at,updated_at) VALUES ('e2e-role','e2e-kejime','朝活E2E','${now}','${now}');`,
    `DELETE FROM slack_role_members WHERE role_id='e2e-role';`,
    `INSERT INTO slack_role_members (role_id,slack_user_id,added_at) VALUES ('e2e-role','UE2E0002','${now}'),('e2e-role','UE2E0003','${now}');`,
    `INSERT INTO kejime_members (id,event_action_id,slack_user_id,display_name,current_points,ramen_count,created_at,updated_at) VALUES ('e2e-km2','e2e-kejime','UE2E0002','E2E遅刻者',2,0,'${now}','${now}');`,
    `INSERT INTO kejime_members (id,event_action_id,slack_user_id,display_name,current_points,ramen_count,created_at,updated_at) VALUES ('e2e-km3','e2e-kejime','UE2E0003','E2E激辛者',0,0,'${now}','${now}');`,
    `INSERT INTO kejime_events (id,member_id,type,points_delta,ramen_delta,note,occurred_at) VALUES ('e2e-late1','e2e-km2','late',2,0,'auto: ${todayJst} (gacha 2pt)','${now}');`,
    `INSERT INTO kejime_penalties (id,event_action_id,member_id,slack_user_id,date,theme,theme_key,points,required_chars,status,late_event_id,created_at) VALUES ('e2e-pen1','e2e-kejime','e2e-km2','UE2E0002','${todayJst}','E2Eテーマ',NULL,2,2000,'open','e2e-late1','${now}');`,
    `DELETE FROM morning_attendance WHERE event_action_id='e2e-morning';`,
    `INSERT INTO morning_attendance (id,event_action_id,date,slack_user_id,status,recorded_at) VALUES ('e2e-ma1','e2e-morning','${todayJst}','UE2E0002','late','${now}');`,
    // ADR-0011 channel_router E2E 用 seed (hackit-e2e イベント)。
    // - 運営名簿: role_management (e2e-cr-roles) + ロール「運営」(e2e-cr-role-ops) にメンバー UE2ECR01。
    // - channel_router action (e2e-cr): config.workspaceId は 'e2e-cr-ws' (workspaces 行は
    //   ダミー。sync / チャンネル一覧はローカルで動かない前提 = 手入力フォールバックを踏む)。
    // - 検出済みメンバー 2 名 (運営 UE2ECR01 / 参加者 UE2ECR02) を pending で直接 seed。
    // - 「運営 -> #ops」ルールは seed 済み。参加者ルールは E2E が UI から追加する
    //   (毎回リセットして決定的にする)。
    `INSERT OR REPLACE INTO events (id,type,name,config,status,created_at) VALUES ('hackit-e2e','hackathon','HackIt E2E','{}','active','${now}');`,
    `INSERT OR REPLACE INTO workspaces (id,name,slack_team_id,bot_token,signing_secret,created_at) VALUES ('e2e-cr-ws','HackIT (E2E)','TE2ECR','dummy','dummy','${now}');`,
    `INSERT OR REPLACE INTO event_actions (id,event_id,action_type,config,enabled,created_at,updated_at) VALUES ('e2e-cr-roles','hackit-e2e','role_management','{"workspaceId":"e2e-cr-ws"}',1,'${now}','${now}');`,
    `INSERT OR REPLACE INTO slack_roles (id,event_action_id,name,created_at,updated_at) VALUES ('e2e-cr-role-ops','e2e-cr-roles','運営','${now}','${now}');`,
    `DELETE FROM slack_role_members WHERE role_id='e2e-cr-role-ops';`,
    `INSERT INTO slack_role_members (role_id,slack_user_id,added_at) VALUES ('e2e-cr-role-ops','UE2ECR01','${now}');`,
    `INSERT OR REPLACE INTO event_actions (id,event_id,action_type,config,enabled,created_at,updated_at) VALUES ('e2e-cr','hackit-e2e','channel_router','{"schemaVersion":1,"workspaceId":"e2e-cr-ws"}',1,'${now}','${now}');`,
    `DELETE FROM channel_router_rules WHERE event_action_id='e2e-cr';`,
    `INSERT INTO channel_router_rules (id,event_action_id,target_kind,role_id,channel_id,channel_name,created_at,updated_at) VALUES ('e2e-cr-rule-ops','e2e-cr','role','e2e-cr-role-ops','CE2EOPS','ops','${now}','${now}');`,
    `DELETE FROM channel_router_members WHERE event_action_id='e2e-cr';`,
    `INSERT INTO channel_router_members (id,event_action_id,slack_user_id,display_name,status,first_seen_at,updated_at) VALUES ('e2e-cr-m1','e2e-cr','UE2ECR01','E2E運営メンバー','pending','${now}','${now}');`,
    `INSERT INTO channel_router_members (id,event_action_id,slack_user_id,display_name,status,first_seen_at,updated_at) VALUES ('e2e-cr-m2','e2e-cr','UE2ECR02','E2E参加者メンバー','pending','${now}','${now}');`,

    // 自動分類タブ (auto-classify) E2E 用。専用イベントで他テストと干渉させない。
    // role_management (ac-roles) は毎回ロールを空にリセット → seed ボタンが必ず出る。
    // workspaceId は dummy workspace を指すので classify-preview (Slack users.list)
    // は失敗し「抽出できません + users:read 必要」の親切表示を踏む (Slack 資格情報なし)。
    `INSERT OR REPLACE INTO events (id,type,name,config,status,created_at) VALUES ('hackit-ac','hackathon','AutoClassify E2E','{}','active','${now}');`,
    `INSERT OR REPLACE INTO event_actions (id,event_id,action_type,config,enabled,created_at,updated_at) VALUES ('ac-roles','hackit-ac','role_management','{"workspaceId":"e2e-cr-ws"}',1,'${now}','${now}');`,
    `INSERT OR REPLACE INTO event_actions (id,event_id,action_type,config,enabled,created_at,updated_at) VALUES ('ac-roster','hackit-ac','member_roster','{}',1,'${now}','${now}');`,
    `DELETE FROM slack_role_members WHERE role_id IN (SELECT id FROM slack_roles WHERE event_action_id='ac-roles');`,
    `DELETE FROM slack_roles WHERE event_action_id='ac-roles';`,

    // 応募フォーム 下書き自動保存 E2E 用。member_application を enabled にし、
    // レガシー config.leaderAvailableSlots に未来 slot を 1 つだけ入れて
    // 公開フォーム (/apply/apply-e2e) を描画可能にする (認証不要の公開エンドポイント)。
    `INSERT OR REPLACE INTO events (id,type,name,config,status,created_at) VALUES ('apply-e2e','meetup','応募E2E','{}','active','${now}');`,
    `INSERT OR REPLACE INTO event_actions (id,event_id,action_type,config,enabled,created_at,updated_at) VALUES ('e2e-apply-ma','apply-e2e','member_application','${applyConfig}',1,'${now}','${now}');`,
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
