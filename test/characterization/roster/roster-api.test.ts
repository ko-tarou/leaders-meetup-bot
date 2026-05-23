/**
 * 名簿管理 PR1 characterization: roster API (D1 integration)。
 *
 * 隔離 D1 (miniflare, 本番非接触) に event/eventAction を seed し、
 * `rosterRouter` をテスト用 Hono app にマウントして実リクエストを投げ、
 * **現状のレスポンス / DB 状態** を固定する。auth 失敗だけは src/routes/api.ts の
 * `api` を /api 配下にマウントして本番同様の admin auth を通す。
 *
 * 固定対象:
 *  - members: list / create / update / soft delete / soft delete 後の listing 除外
 *  - columns: create (type/optionsJson 検証) / delete (関連 values も連鎖削除)
 *  - values: upsert (insert / update 両方) / delete
 *  - 異常系: action 不在 (404)、auth 失敗 (401)
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { rosterRouter } from "../../../src/routes/api/roster";
import { api } from "../../../src/routes/api";
import { makeEnv } from "../../helpers/env";
import { testDb } from "../../helpers/db";
import { makeEvent, makeEventAction } from "../../helpers/factory";
import {
  rosterMembers,
  rosterCustomColumns,
  rosterMemberValues,
} from "../../../src/db/schema";
import { eq } from "drizzle-orm";

const env = makeEnv();

/** behavior 検証用: rosterRouter を "/" 直下にマウント (adminAuth 非経由)。 */
function app() {
  const a = new Hono<{ Bindings: ReturnType<typeof makeEnv> }>();
  a.route("/", rosterRouter);
  return a;
}

/** auth 検証用: 本番 src/index.ts と同じ /api 配下マウント。 */
function authApp() {
  const a = new Hono<{ Bindings: ReturnType<typeof makeEnv> }>();
  a.route("/api", api);
  return a;
}

async function reqJson(
  path: string,
  method: string,
  body?: unknown,
) {
  return app().request(
    path,
    {
      method,
      headers:
        body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    },
    env,
  );
}

/** event + member_roster (相当) action を seed する。 */
async function setup() {
  const ev = await makeEvent();
  const action = await makeEventAction(ev.id, {
    actionType: "member_roster",
  });
  return { ev, action };
}

// ---------------------------------------------------------------------------
// auth (admin Bearer 必須)
// ---------------------------------------------------------------------------
describe("auth", () => {
  it("x-admin-token 無しは 401 unauthorized", async () => {
    const res = await authApp().request(
      "/api/event-actions/anything/roster/members",
      {},
      env,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });
});

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------
describe("members CRUD", () => {
  it("action 不在 → 404 'action not found'", async () => {
    const res = await app().request(
      "/event-actions/ghost/roster/members",
      {},
      env,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "action not found" });
  });

  it("POST: name 必須 (空白のみ → 400)", async () => {
    const { action } = await setup();
    const res = await reqJson(
      `/event-actions/${action.id}/roster/members`,
      "POST",
      { name: "  " },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "name is required" });
  });

  it("POST: 正常作成 → 201、name trim、status は省略時 'active'", async () => {
    const { action } = await setup();
    const res = await reqJson(
      `/event-actions/${action.id}/roster/members`,
      "POST",
      { name: "  山田 太郎 ", grade: "B3", email: " a@b.c " },
    );
    expect(res.status).toBe(201);
    const row = (await res.json()) as {
      id: string;
      name: string;
      grade: string;
      email: string;
      status: string;
      deletedAt: string | null;
    };
    expect(row.name).toBe("山田 太郎");
    expect(row.grade).toBe("B3");
    expect(row.email).toBe("a@b.c");
    expect(row.status).toBe("active");
    expect(row.deletedAt).toBeNull();
  });

  it("POST: status enum 違反 → 400", async () => {
    const { action } = await setup();
    const res = await reqJson(
      `/event-actions/${action.id}/roster/members`,
      "POST",
      { name: "X", status: "purged" },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid status" });
  });

  // PR3 (2026-05): 参加届からの取り込みで Slack 情報を一緒に保存できる。
  it("POST: Slack 情報 (slackEmail/slackName/slackUserId) を一緒に保存できる", async () => {
    const { action } = await setup();
    const res = await reqJson(
      `/event-actions/${action.id}/roster/members`,
      "POST",
      {
        name: "佐藤 花子",
        email: "hanako@school.example.com",
        slackEmail: "hanako@slack.example.com",
        slackName: "hanako_slack",
        slackUserId: "U_HANAKO",
        joinedAt: "2026-05-10T00:00:00.000Z",
      },
    );
    expect(res.status).toBe(201);
    const row = (await res.json()) as {
      email: string | null;
      slackEmail: string | null;
      slackName: string | null;
      slackUserId: string | null;
      joinedAt: string | null;
    };
    expect(row.email).toBe("hanako@school.example.com");
    expect(row.slackEmail).toBe("hanako@slack.example.com");
    expect(row.slackName).toBe("hanako_slack");
    expect(row.slackUserId).toBe("U_HANAKO");
    expect(row.joinedAt).toBe("2026-05-10T00:00:00.000Z");
  });

  it("GET: list は createdAt 昇順、soft-deleted は除外、inactive は default で除外", async () => {
    const { action } = await setup();
    // 直接 insert で createdAt を制御
    const now = "2026-05-17T00:00:00.000Z";
    await testDb().insert(rosterMembers).values([
      {
        id: "m-1",
        eventActionId: action.id,
        name: "A",
        status: "active",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: now,
      },
      {
        id: "m-2",
        eventActionId: action.id,
        name: "B",
        status: "inactive",
        createdAt: "2026-05-02T00:00:00.000Z",
        updatedAt: now,
      },
      {
        id: "m-3",
        eventActionId: action.id,
        name: "C",
        status: "active",
        createdAt: "2026-05-03T00:00:00.000Z",
        updatedAt: now,
        deletedAt: now,
      },
    ]);
    const res = await app().request(
      `/event-actions/${action.id}/roster/members`,
      {},
      env,
    );
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ id: string }>;
    // A のみ (B=inactive 除外, C=deleted 除外)
    expect(rows.map((r) => r.id)).toEqual(["m-1"]);

    // includeInactive=1 で inactive も含む (soft-deleted は引き続き除外)
    const res2 = await app().request(
      `/event-actions/${action.id}/roster/members?includeInactive=1`,
      {},
      env,
    );
    const rows2 = (await res2.json()) as Array<{ id: string }>;
    expect(rows2.map((r) => r.id)).toEqual(["m-1", "m-2"]);
  });

  it("PUT: 部分更新 (name trim, status enum)", async () => {
    const { action } = await setup();
    const cr = await reqJson(
      `/event-actions/${action.id}/roster/members`,
      "POST",
      { name: "Old" },
    );
    const id = ((await cr.json()) as { id: string }).id;

    const res = await reqJson(
      `/event-actions/${action.id}/roster/members/${id}`,
      "PUT",
      { name: "  New ", status: "inactive", note: "  " },
    );
    expect(res.status).toBe(200);
    const row = (await res.json()) as {
      name: string;
      status: string;
      note: string | null;
    };
    expect(row.name).toBe("New");
    expect(row.status).toBe("inactive");
    expect(row.note).toBeNull();
  });

  it("DELETE: soft delete (deleted_at set) → listing から消える", async () => {
    const { action } = await setup();
    const cr = await reqJson(
      `/event-actions/${action.id}/roster/members`,
      "POST",
      { name: "X" },
    );
    const id = ((await cr.json()) as { id: string }).id;
    const del = await reqJson(
      `/event-actions/${action.id}/roster/members/${id}`,
      "DELETE",
    );
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });

    // DB 上は残るが deleted_at が set される
    const row = await testDb()
      .select()
      .from(rosterMembers)
      .where(eq(rosterMembers.id, id))
      .get();
    expect(row?.deletedAt).not.toBeNull();

    // list 経由では出てこない
    const list = await app().request(
      `/event-actions/${action.id}/roster/members`,
      {},
      env,
    );
    const rows = (await list.json()) as unknown[];
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------
describe("custom columns CRUD", () => {
  it("POST: type 不正 → 400", async () => {
    const { action } = await setup();
    const res = await reqJson(
      `/event-actions/${action.id}/roster/columns`,
      "POST",
      { columnKey: "k", label: "L", type: "blob" },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid type" });
  });

  it("POST: select 時 optionsJson 必須 (配列でないと 400)", async () => {
    const { action } = await setup();
    const res = await reqJson(
      `/event-actions/${action.id}/roster/columns`,
      "POST",
      { columnKey: "k", label: "L", type: "select" },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "optionsJson must be an array for select",
    });
  });

  it("POST: 正常作成 (type=select で options を JSON 文字列に格納)", async () => {
    const { action } = await setup();
    const res = await reqJson(
      `/event-actions/${action.id}/roster/columns`,
      "POST",
      {
        columnKey: "dept",
        label: "部署",
        type: "select",
        optionsJson: ["pm", "be", "fe"],
        sortOrder: 3,
      },
    );
    expect(res.status).toBe(201);
    const row = (await res.json()) as {
      columnKey: string;
      type: string;
      optionsJson: string;
      sortOrder: number;
    };
    expect(row.columnKey).toBe("dept");
    expect(row.type).toBe("select");
    expect(JSON.parse(row.optionsJson)).toEqual(["pm", "be", "fe"]);
    expect(row.sortOrder).toBe(3);
  });

  it("DELETE: column 削除で関連 values も連鎖削除", async () => {
    const { action } = await setup();
    // member と column を seed
    const mc = await reqJson(
      `/event-actions/${action.id}/roster/members`,
      "POST",
      { name: "M" },
    );
    const mId = ((await mc.json()) as { id: string }).id;
    const cc = await reqJson(
      `/event-actions/${action.id}/roster/columns`,
      "POST",
      { columnKey: "k", label: "L", type: "text" },
    );
    const cId = ((await cc.json()) as { id: string }).id;
    // value を 1 件 set
    await reqJson(
      `/event-actions/${action.id}/roster/members/${mId}/values/${cId}`,
      "PUT",
      { value: "hello" },
    );
    // 連鎖削除確認
    const del = await reqJson(
      `/event-actions/${action.id}/roster/columns/${cId}`,
      "DELETE",
    );
    expect(del.status).toBe(200);
    const cols = await testDb()
      .select()
      .from(rosterCustomColumns)
      .where(eq(rosterCustomColumns.id, cId))
      .all();
    expect(cols).toHaveLength(0);
    const vals = await testDb()
      .select()
      .from(rosterMemberValues)
      .where(eq(rosterMemberValues.columnId, cId))
      .all();
    expect(vals).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Member values
// ---------------------------------------------------------------------------
describe("member values upsert", () => {
  it("PUT: 1 回目で insert(201)、2 回目で update(200) - JSON.stringify される", async () => {
    const { action } = await setup();
    const mc = await reqJson(
      `/event-actions/${action.id}/roster/members`,
      "POST",
      { name: "M" },
    );
    const mId = ((await mc.json()) as { id: string }).id;
    const cc = await reqJson(
      `/event-actions/${action.id}/roster/columns`,
      "POST",
      { columnKey: "memo", label: "メモ", type: "text" },
    );
    const cId = ((await cc.json()) as { id: string }).id;

    const r1 = await reqJson(
      `/event-actions/${action.id}/roster/members/${mId}/values/${cId}`,
      "PUT",
      { value: "first" },
    );
    expect(r1.status).toBe(201);
    expect(((await r1.json()) as { valueJson: string }).valueJson).toBe(
      JSON.stringify("first"),
    );

    const r2 = await reqJson(
      `/event-actions/${action.id}/roster/members/${mId}/values/${cId}`,
      "PUT",
      { value: { x: 1, y: [true, null] } },
    );
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as { valueJson: string }).valueJson).toBe(
      JSON.stringify({ x: 1, y: [true, null] }),
    );

    // DB 上に 1 行のみ (UNIQUE (member_id, column_id))
    const rows = await testDb()
      .select()
      .from(rosterMemberValues)
      .where(eq(rosterMemberValues.memberId, mId))
      .all();
    expect(rows).toHaveLength(1);
  });

  it("GET /roster/values: action 配下の全値を bulk fetch (PR5b)", async () => {
    const { action } = await setup();
    const mc = await reqJson(
      `/event-actions/${action.id}/roster/members`, "POST", { name: "M" });
    const mId = ((await mc.json()) as { id: string }).id;
    const cc = await reqJson(
      `/event-actions/${action.id}/roster/columns`, "POST",
      { columnKey: "k", label: "L", type: "text" });
    const cId = ((await cc.json()) as { id: string }).id;
    await reqJson(
      `/event-actions/${action.id}/roster/members/${mId}/values/${cId}`,
      "PUT", { value: "hi" });

    const res = await app().request(
      `/event-actions/${action.id}/roster/values`, {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      memberId: string; columnId: string; valueJson: string;
    }>;
    expect(body).toHaveLength(1);
    expect(body[0]!.memberId).toBe(mId);
    expect(body[0]!.columnId).toBe(cId);
    expect(JSON.parse(body[0]!.valueJson)).toBe("hi");
  });
});
