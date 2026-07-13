#!/usr/bin/env node
/**
 * DevHub Ops 操作用 CLI クライアント (ADR-0010: API ファースト運用)。
 *
 * ユーザーと同じ管理 API (/api/* + x-admin-token) を叩く。DB 直 SQL 書き込みの代替。
 *
 * 使い方:
 *   LMB_ADMIN_TOKEN=xxx node scripts/lmb-api.mjs <command> [...args]
 *
 * 環境変数:
 *   LMB_BASE_URL     既定 https://leaders-meetup-bot.akokoa1221.workers.dev
 *                    (ローカル検証は http://localhost:8787 等に差し替え)
 *   LMB_ADMIN_TOKEN  必須。adminAuth 用トークン (コミット禁止)
 *   LMB_ACTOR        tasks の createdBySlackId に入れる値 (既定 "cli")
 *
 * コマンド:
 *   events list | events create <name> [--type project]
 *   actions list <eventId> | actions add <eventId> <actionType> [--config <json|@file>]
 *   actions update <eventId> <actionId> [--config <json|@file>] [--enabled 0|1]
 *   tasks list <eventId> | tasks create <eventId> --title <t> [--wbs --team --phase
 *       --start YYYY-MM-DD --end YYYY-MM-DD --status todo|doing|done --progress N --desc <d>]
 *   tasks update <taskId> [同上フラグ] | tasks delete <taskId>
 *   gantt import <eventId> <file.json>   (wbs 重複はスキップ = 冪等)
 *   gantt summary <eventId> | gantt monthly <eventId>
 *   deps list <eventId> | deps add <eventId> <taskId> <dependsOnTaskId> | deps rm <eventId> <depId>
 *   raw <METHOD> <path> [json|@file]     (例: raw GET /orgs)
 */
import { readFileSync } from "node:fs";

const BASE_URL =
  process.env.LMB_BASE_URL || "https://leaders-meetup-bot.akokoa1221.workers.dev";
const TOKEN = process.env.LMB_ADMIN_TOKEN || process.env.ADMIN_TOKEN;
const ACTOR = process.env.LMB_ACTOR || "cli";

if (!TOKEN) {
  console.error("LMB_ADMIN_TOKEN env var is required");
  process.exit(1);
}

async function api(method, path, body) {
  const res = await fetch(`${BASE_URL}/api${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-admin-token": TOKEN,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : undefined;
}

/** "--key value" 群を {key: value} に。--key の重複は後勝ち。 */
function parseFlags(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      flags[args[i].slice(2)] = args[i + 1];
      i++;
    } else rest.push(args[i]);
  }
  return { flags, rest };
}

/** "@file.json" ならファイルを読む。それ以外はそのまま。 */
function maybeFile(v) {
  return v?.startsWith("@") ? readFileSync(v.slice(1), "utf-8") : v;
}

/** "YYYY-MM-DD" -> UTC ISO。ISO 済みならそのまま。 */
function toIso(d) {
  if (!d) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00.000Z` : d;
}

const STATUS_MAP = { 未着手: "todo", 進行中: "doing", 完了: "done" };
function toStatus(s) {
  if (!s) return undefined;
  return STATUS_MAP[s] ?? s;
}

/** WBS "3.2" -> フェーズ "F3" */
function phaseFromWbs(wbs) {
  const major = wbs?.split(".")[0];
  return major ? `F${major}` : undefined;
}

function taskBodyFromFlags(flags) {
  const body = {};
  if (flags.title !== undefined) body.title = flags.title;
  if (flags.desc !== undefined) body.description = flags.desc;
  if (flags.wbs !== undefined) body.wbs = flags.wbs;
  if (flags.team !== undefined) body.team = flags.team;
  if (flags.phase !== undefined) body.phase = flags.phase;
  if (flags.start !== undefined) body.startAt = toIso(flags.start);
  if (flags.end !== undefined) body.dueAt = toIso(flags.end);
  if (flags.status !== undefined) body.status = toStatus(flags.status);
  if (flags.progress !== undefined) body.progressPct = Number(flags.progress);
  return body;
}

function print(v) {
  console.log(JSON.stringify(v, null, 2));
}

const [cmd, sub, ...args] = process.argv.slice(2);
const { flags, rest } = parseFlags(args);

async function main() {
  switch (`${cmd} ${sub}`) {
    case "events list":
      return print(await api("GET", "/orgs"));
    case "events create": {
      const [name] = rest;
      if (!name) throw new Error("usage: events create <name> [--type project]");
      return print(
        await api("POST", "/orgs", { name, type: flags.type ?? "project" }),
      );
    }
    case "actions list":
      return print(await api("GET", `/orgs/${rest[0]}/actions`));
    case "actions add": {
      const [eventId, actionType] = rest;
      const body = { actionType };
      if (flags.config) body.config = maybeFile(flags.config);
      return print(await api("POST", `/orgs/${eventId}/actions`, body));
    }
    case "actions update": {
      const [eventId, actionId] = rest;
      const body = {};
      if (flags.config) body.config = maybeFile(flags.config);
      if (flags.enabled !== undefined) body.enabled = Number(flags.enabled);
      return print(await api("PUT", `/orgs/${eventId}/actions/${actionId}`, body));
    }
    case "tasks list":
      return print(await api("GET", `/tasks?eventId=${rest[0]}`));
    case "tasks create": {
      const [eventId] = rest;
      const body = {
        eventId,
        createdBySlackId: ACTOR,
        ...taskBodyFromFlags(flags),
      };
      if (body.wbs && !body.phase) body.phase = phaseFromWbs(body.wbs);
      return print(await api("POST", "/tasks", body));
    }
    case "tasks update":
      return print(await api("PUT", `/tasks/${rest[0]}`, taskBodyFromFlags(flags)));
    case "tasks delete":
      return print(await api("DELETE", `/tasks/${rest[0]}`));
    case "gantt import": {
      const [eventId, file] = rest;
      if (!eventId || !file) throw new Error("usage: gantt import <eventId> <file.json>");
      const items = JSON.parse(readFileSync(file, "utf-8"));
      const existing = await api("GET", `/tasks?eventId=${eventId}`);
      const seen = new Set(existing.map((t) => t.wbs).filter(Boolean));
      let created = 0;
      let skipped = 0;
      for (const item of items) {
        if (item.wbs && seen.has(item.wbs)) {
          skipped++;
          continue;
        }
        await api("POST", "/tasks", {
          eventId,
          createdBySlackId: ACTOR,
          title: item.title ?? item.task,
          wbs: item.wbs,
          team: item.team,
          phase: item.phase ?? phaseFromWbs(item.wbs),
          status: toStatus(item.status) ?? "todo",
          startAt: toIso(item.start),
          dueAt: toIso(item.end),
          progressPct: item.progress,
        });
        created++;
      }
      return print({ created, skipped, total: items.length });
    }
    case "gantt summary":
      return print(await api("GET", `/gantt/${rest[0]}/summary`));
    case "gantt monthly":
      return print(await api("GET", `/gantt/${rest[0]}/monthly`));
    case "deps list":
      return print(await api("GET", `/gantt/${rest[0]}/dependencies`));
    case "deps add": {
      const [eventId, taskId, dependsOnTaskId] = rest;
      return print(
        await api("POST", `/gantt/${eventId}/dependencies`, { taskId, dependsOnTaskId }),
      );
    }
    case "deps rm":
      return print(await api("DELETE", `/gantt/${rest[0]}/dependencies/${rest[1]}`));
    default: {
      if (cmd === "raw") {
        const [path, body] = rest;
        const method = sub?.toUpperCase();
        if (!method || !path) throw new Error("usage: raw <METHOD> <path> [json|@file]");
        return print(
          await api(method, path, body ? JSON.parse(maybeFile(body)) : undefined),
        );
      }
      console.error(
        "unknown command. see header of scripts/lmb-api.mjs for usage",
      );
      process.exit(1);
    }
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
