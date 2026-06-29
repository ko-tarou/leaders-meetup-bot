#!/usr/bin/env node
/**
 * イベントごとに「運営」配下の子ロールを 1 つ作る CLI ショートカット。
 *
 * 実体は API POST /api/orgs/:eventId/actions/:actionId/event-child-role を叩くだけ。
 * 親ロール「運営」(ルート) はサーバ側が自動解決する。
 *
 * 使い方:
 *   ADMIN_TOKEN=xxx node scripts/create-event-child-role.mjs <eventId> <actionId> [子ロール名] [親ロール名]
 *
 * 例 (HackIT のイベントに子ロールを作る):
 *   ADMIN_TOKEN=xxx BASE_URL=https://devhub-ops.example.workers.dev \
 *     node scripts/create-event-child-role.mjs evt_hackit ea_role_hackit "HackIT 運営チーム"
 *
 * 環境変数:
 *   BASE_URL      既定 http://127.0.0.1:8787 (wrangler dev)
 *   ADMIN_TOKEN   必須。adminAuth 用 Bearer トークン。
 */
const [eventId, actionId, name, parentName] = process.argv.slice(2);
const baseUrl = process.env.BASE_URL || "http://127.0.0.1:8787";
const adminToken = process.env.ADMIN_TOKEN;

if (!eventId || !actionId) {
  console.error(
    "usage: ADMIN_TOKEN=xxx node scripts/create-event-child-role.mjs <eventId> <actionId> [子ロール名] [親ロール名]",
  );
  process.exit(1);
}
if (!adminToken) {
  console.error("ADMIN_TOKEN env var is required");
  process.exit(1);
}

const url = `${baseUrl}/api/orgs/${eventId}/actions/${actionId}/event-child-role`;
const body = {};
if (name) body.name = name;
if (parentName) body.parentName = parentName;

const res = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${adminToken}`,
  },
  body: JSON.stringify(body),
});
const text = await res.text();
if (!res.ok) {
  console.error(`failed (${res.status}): ${text}`);
  process.exit(1);
}
console.log("created child role:", text);
