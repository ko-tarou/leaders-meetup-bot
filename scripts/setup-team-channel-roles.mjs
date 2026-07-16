#!/usr/bin/env node
/**
 * team1..N の各チームロールを「参加者」配下に一括作成し、対応する Slack
 * チャンネルに紐付け、在籍者を同期する CLI (HackIT のチーム運用)。
 *
 * 実体は POST /api/orgs/:eventId/actions/:actionId/roles/team-channel-setup を
 * subrequest 上限に当たらないよう少数ずつ (--batch, 既定 5) 分割して叩くだけ。
 * 全ステップ冪等 (再実行しても重複作成・重複付与しない)。
 *
 * チャンネル対応付け: GET /api/slack/channels?workspaceId=... の一覧から
 * `--channel-prefix` (既定 "2026_team") + N で名前一致させて channelId を解決する。
 * ロール名は `--role-prefix` (既定 "team") + N。
 *
 * 使い方:
 *   LMB_ADMIN_TOKEN=xxx node scripts/setup-team-channel-roles.mjs \
 *     --event <eventId> --action <actionId> --workspace <workspaceId> \
 *     [--count 30] [--parent 参加者] [--role-prefix team] \
 *     [--channel-prefix 2026_team] [--batch 5] [--dry-run] [--no-sync]
 *
 * 環境変数:
 *   LMB_BASE_URL     既定 http://localhost:8799 (wrangler dev --remote)
 *   LMB_ADMIN_TOKEN  必須。x-admin-token。
 */
const BASE_URL = process.env.LMB_BASE_URL || "http://localhost:8799";
const TOKEN = process.env.LMB_ADMIN_TOKEN || process.env.ADMIN_TOKEN;
if (!TOKEN) {
  console.error("LMB_ADMIN_TOKEN env var is required");
  process.exit(1);
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }
  return flags;
}

const flags = parseFlags(process.argv.slice(2));
const eventId = flags.event;
const actionId = flags.action;
const workspaceId = flags.workspace;
if (!eventId || !actionId || !workspaceId) {
  console.error(
    "usage: --event <eventId> --action <actionId> --workspace <workspaceId> [--count 30] [--parent 参加者] [--role-prefix team] [--channel-prefix 2026_team] [--batch 5] [--dry-run] [--no-sync]",
  );
  process.exit(1);
}
const count = Number(flags.count ?? 30);
const parentRoleName = flags.parent ?? "参加者";
const rolePrefix = flags["role-prefix"] ?? "team";
const channelPrefix = flags["channel-prefix"] ?? "2026_team";
const batchSize = Number(flags.batch ?? 5);
const dryRun = flags["dry-run"] === true;
const sync = flags["no-sync"] !== true;

async function api(method, path, body) {
  const res = await fetch(`${BASE_URL}/api${path}`, {
    method,
    headers: { "content-type": "application/json", "x-admin-token": TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} failed (${res.status}): ${text.slice(0, 400)}`);
  }
  return text ? JSON.parse(text) : undefined;
}

async function main() {
  // 1) チャンネル一覧を取得して name -> id を作る。
  const channels = await api(
    "GET",
    `/slack/channels?workspaceId=${encodeURIComponent(workspaceId)}`,
  );
  const idByName = new Map(channels.map((ch) => [ch.name, ch.id]));

  // 2) team1..count のペアを作る (チャンネルが無ければ skip して警告)。
  const teams = [];
  const missing = [];
  for (let n = 1; n <= count; n++) {
    const channelName = `${channelPrefix}${n}`;
    const channelId = idByName.get(channelName);
    if (!channelId) {
      missing.push(channelName);
      continue;
    }
    teams.push({ roleName: `${rolePrefix}${n}`, channelId });
  }
  if (missing.length > 0) {
    console.warn(`WARN: channels not found (skipped): ${missing.join(", ")}`);
  }
  console.log(
    `resolved ${teams.length}/${count} teams. parent=${parentRoleName} sync=${sync} dryRun=${dryRun} batch=${batchSize}`,
  );

  // 3) batch 分割で POST (subrequest 上限対策)。
  const allResults = [];
  for (let i = 0; i < teams.length; i += batchSize) {
    const batch = teams.slice(i, i + batchSize);
    const out = await api(
      "POST",
      `/orgs/${eventId}/actions/${actionId}/roles/team-channel-setup`,
      { parentRoleName, teams: batch, sync, dryRun },
    );
    for (const r of out.results) {
      allResults.push(r);
      console.log(
        `${r.roleName} <- (${r.channelId}) created=${r.created} bound=${r.channelBound} ` +
          `members=${r.channelMemberCount} +team=${r.addedToTeam} +ancestors=${r.addedToAncestors}` +
          (r.errors && r.errors.length ? ` errors=${JSON.stringify(r.errors)}` : ""),
      );
    }
  }

  const totals = allResults.reduce(
    (acc, r) => {
      acc.created += r.created ? 1 : 0;
      acc.channelMemberCount += r.channelMemberCount;
      acc.addedToTeam += r.addedToTeam;
      acc.errors += r.errors ? r.errors.length : 0;
      return acc;
    },
    { created: 0, channelMemberCount: 0, addedToTeam: 0, errors: 0 },
  );
  console.log("--- totals ---");
  console.log(JSON.stringify({ teams: allResults.length, ...totals }, null, 2));
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
