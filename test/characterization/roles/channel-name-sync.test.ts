/**
 * ロール名 ⇄ チャンネル名 同期の検証。
 *
 * 観点:
 *   - normalizeChannelName: 日本語はそのまま / 空白・大文字・記号は正規化 / 上限
 *   - GET channel-name-diff: 現状名→ロール名(正規化) の差分・冪等(一致は needsRename=false)
 *   - POST channel-name-sync: 選択チャンネルを rename・一致は skip・not_authorized を error 化
 *   - PUT roles/:roleId (syncChannelName): name 変更時に単一紐付けチャンネルを追随 rename
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { MockSlackClient } from "../../mocks/slack";

vi.mock("../../../src/services/slack-api", () => ({
  SlackClient: class {
    constructor() {
      return new MockSlackClient() as unknown as object;
    }
  },
}));

import { normalizeChannelName } from "../../../src/domain/role/channel-name";
import { rolesRouter } from "../../../src/routes/api/roles";
import { makeEnv } from "../../helpers/env";
import { testDb } from "../../helpers/db";
import {
  makeEvent,
  makeEventAction,
  makeEncryptedWorkspace,
  makeSlackRole,
} from "../../helpers/factory";
import { slackRoleChannels } from "../../../src/db/schema";

const env = makeEnv();
function app() {
  const a = new Hono<{ Bindings: ReturnType<typeof makeEnv> }>();
  a.route("/", rolesRouter);
  return a;
}

/** getChannelInfo が返す現状名を channelId ごとに固定する。 */
function stubChannelNames(byChannel: Record<string, string>) {
  vi.spyOn(MockSlackClient.prototype, "getChannelInfo").mockImplementation(
    // @ts-expect-error テスト用シグネチャ簡略化
    async (channel: string) => {
      const name = byChannel[channel];
      return name === undefined
        ? { ok: false, error: "channel_not_found" }
        : { ok: true, channel: { id: channel, name } };
    },
  );
}

async function bindChannel(roleId: string, channelId: string) {
  await testDb()
    .insert(slackRoleChannels)
    .values({ roleId, channelId, addedAt: new Date().toISOString() });
}

async function setup() {
  const { row: ws } = await makeEncryptedWorkspace();
  const event = await makeEvent();
  const action = await makeEventAction(event.id, {
    actionType: "role_management",
    config: JSON.stringify({ workspaceId: ws.id }),
  });
  return { event, action };
}

beforeEach(() => vi.restoreAllMocks());

describe("normalizeChannelName", () => {
  it("日本語 + 数字はそのまま通る (チーム1)", () => {
    const r = normalizeChannelName("チーム1");
    expect(r.name).toBe("チーム1");
    expect(r.changed).toBe(false);
    expect(r.warnings).toEqual([]);
  });

  it("空白は ハイフンへ・大文字は小文字化し warning を出す", () => {
    const r = normalizeChannelName("Team Alpha");
    expect(r.name).toBe("team-alpha");
    expect(r.changed).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("記号を除去し連続ハイフンを畳む", () => {
    expect(normalizeChannelName("チーム #1!!").name).toBe("チーム-1");
  });

  it("80文字上限で切り詰める", () => {
    const r = normalizeChannelName("a".repeat(100));
    expect(r.name.length).toBe(80);
    expect(r.warnings.join()).toContain("80");
  });
});

describe("GET channel-name-diff", () => {
  it("現状名とロール名の差分を返し、一致は needsRename=false", async () => {
    const { event, action } = await setup();
    const r1 = await makeSlackRole(action.id, { name: "チーム1" });
    const r2 = await makeSlackRole(action.id, { name: "チーム2" });
    await bindChannel(r1.id, "C1");
    await bindChannel(r2.id, "C2");
    // C1 は既に一致 / C2 は旧名 team-2
    stubChannelNames({ C1: "チーム1", C2: "team-2" });

    const res = await app().request(
      `/orgs/${event.id}/actions/${action.id}/channel-name-diff`,
      {},
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      items: Array<{
        roleName: string;
        currentName: string;
        targetName: string;
        needsRename: boolean;
      }>;
    };
    expect(body.total).toBe(2);
    const c1 = body.items.find((i) => i.roleName === "チーム1")!;
    const c2 = body.items.find((i) => i.roleName === "チーム2")!;
    expect(c1.needsRename).toBe(false);
    expect(c2.needsRename).toBe(true);
    expect(c2.targetName).toBe("チーム2");
  });
});

describe("POST channel-name-sync", () => {
  it("要リネームのチャンネルだけ rename し、一致は skip する", async () => {
    const { event, action } = await setup();
    const r1 = await makeSlackRole(action.id, { name: "チーム1" });
    const r2 = await makeSlackRole(action.id, { name: "チーム2" });
    await bindChannel(r1.id, "C1");
    await bindChannel(r2.id, "C2");
    stubChannelNames({ C1: "チーム1", C2: "team-2" });
    const renameSpy = vi
      .spyOn(MockSlackClient.prototype, "renameChannel")
      .mockResolvedValue({
        ok: true,
        channel: { name: "チーム2" },
      } as never);

    const res = await app().request(
      `/orgs/${event.id}/actions/${action.id}/channel-name-sync`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelIds: ["C1", "C2"] }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      renamed: number;
      skipped: number;
    };
    expect(body.renamed).toBe(1);
    expect(body.skipped).toBe(1);
    // C2 のみ rename が呼ばれる (C1 は一致で skip)。
    expect(renameSpy).toHaveBeenCalledTimes(1);
    expect(renameSpy).toHaveBeenCalledWith("C2", "チーム2");
  });

  it("not_authorized を error として返す (fail-soft)", async () => {
    const { event, action } = await setup();
    const r1 = await makeSlackRole(action.id, { name: "チーム1" });
    await bindChannel(r1.id, "C1");
    stubChannelNames({ C1: "old-name" });
    vi.spyOn(MockSlackClient.prototype, "renameChannel").mockResolvedValue({
      ok: false,
      error: "not_authorized",
    } as never);

    const res = await app().request(
      `/orgs/${event.id}/actions/${action.id}/channel-name-sync`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelIds: ["C1"] }),
      },
      env,
    );
    const body = (await res.json()) as {
      renamed: number;
      results: Array<{ status: string; error?: string }>;
    };
    expect(body.renamed).toBe(0);
    expect(body.results[0].status).toBe("error");
    expect(body.results[0].error).toBe("not_authorized");
  });

  it("dryRun は rename を呼ばず planned を返す", async () => {
    const { event, action } = await setup();
    const r1 = await makeSlackRole(action.id, { name: "チーム1" });
    await bindChannel(r1.id, "C1");
    stubChannelNames({ C1: "old-name" });
    const renameSpy = vi.spyOn(MockSlackClient.prototype, "renameChannel");

    const res = await app().request(
      `/orgs/${event.id}/actions/${action.id}/channel-name-sync`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dryRun: true }),
      },
      env,
    );
    const body = (await res.json()) as {
      results: Array<{ status: string }>;
    };
    expect(renameSpy).not.toHaveBeenCalled();
    expect(body.results[0].status).toBe("planned");
  });
});

describe("PUT roles/:roleId (syncChannelName 自動追随)", () => {
  it("name 変更 + syncChannelName=true で単一紐付けチャンネルを rename する", async () => {
    const { event, action } = await setup();
    const role = await makeSlackRole(action.id, { name: "チーム1" });
    await bindChannel(role.id, "C1");
    stubChannelNames({ C1: "team-1" });
    const renameSpy = vi
      .spyOn(MockSlackClient.prototype, "renameChannel")
      .mockResolvedValue({ ok: true, channel: { name: "チーム99" } } as never);

    const res = await app().request(
      `/orgs/${event.id}/actions/${action.id}/roles/${role.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "チーム99", syncChannelName: true }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      name: string;
      channelRename?: { ok: boolean; to: string };
    };
    expect(body.name).toBe("チーム99");
    expect(body.channelRename?.ok).toBe(true);
    expect(renameSpy).toHaveBeenCalledWith("C1", "チーム99");
  });

  it("syncChannelName 未指定なら rename しない (従来動作)", async () => {
    const { event, action } = await setup();
    const role = await makeSlackRole(action.id, { name: "チーム1" });
    await bindChannel(role.id, "C1");
    const renameSpy = vi.spyOn(MockSlackClient.prototype, "renameChannel");

    const res = await app().request(
      `/orgs/${event.id}/actions/${action.id}/roles/${role.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "チーム2" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(renameSpy).not.toHaveBeenCalled();
  });
});
