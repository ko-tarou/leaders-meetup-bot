/**
 * participant_broadcast: 参加者 (participation_forms) 学籍番号ソースの
 * ドライラン (preview) 統合テスト。
 *
 * 隔離 D1 (miniflare, 本番非接触) に events / event_actions / participation_forms
 * を seed し、source=participants で preview を呼ぶ。
 *   - 学籍番号 -> `c<学籍番号>@st.kanazawa-it.ac.jp` が生成されること
 *   - 学籍番号なし/不正の参加者が skipped に回ること
 *   - preview では Gmail に一切触れない (fetch 呼び出しゼロ) こと
 * ※ 学籍番号はすべてダミー。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { broadcastRouter } from "../../../src/routes/api/broadcast";
import { makeEnv } from "../../helpers/env";
import { testDb } from "../../helpers/db";
import { events, eventActions, participationForms } from "../../../src/db/schema";
import type { Env } from "../../../src/types/env";

const env = makeEnv();
const EVENT_ID = "evt-kit-1";
const ACTION_ID = "act-kit-1";

function app() {
  const a = new Hono<{ Bindings: Env }>();
  a.route("/", broadcastRouter);
  return a;
}

const now = new Date().toISOString();

let fetchCalls = 0;
beforeEach(async () => {
  fetchCalls = 0;
  vi.stubGlobal("fetch", async () => {
    fetchCalls++;
    return new Response("{}", { status: 200 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("participant_broadcast preview (source=participants)", () => {
  it("dry-run: 学籍番号 -> KIT メール生成・skipped 集計・Gmail 非接触", async () => {
    // FK のため events (対象 + 別イベント) を先に作ってから参加者を入れる。
    const db = testDb();
    await db.insert(events).values([
      { id: EVENT_ID, type: "hackit", name: "Hackit 2026", createdAt: now },
      { id: "evt-other", type: "hackit", name: "Other", createdAt: now },
    ]);
    await db.insert(eventActions).values({
      id: ACTION_ID,
      eventId: EVENT_ID,
      actionType: "participant_broadcast",
      createdAt: now,
      updatedAt: now,
    });
    const base = {
      eventId: EVENT_ID,
      email: "ignored@gmail.com",
      hasAllergy: 0 as const,
      devRoles: "[]",
      status: "submitted" as const,
      assignedRoleIds: "[]",
      submittedAt: now,
      createdAt: now,
    };
    await db.insert(participationForms).values([
      { id: "p1", name: "田中太郎", studentId: "1234567", ...base },
      { id: "p2", name: "山田花子", studentId: "c7654321", ...base },
      { id: "p3", name: "学籍番号なし", studentId: null, ...base },
      { id: "p4", name: "不正番号", studentId: "abc", ...base },
      {
        id: "p5",
        name: "別イベント",
        studentId: "9998887",
        ...base,
        eventId: "evt-other",
      },
    ]);

    const res = await app().request(
      `/orgs/${EVENT_ID}/actions/${ACTION_ID}/participant-broadcast/preview`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "participants",
          subject: "【Hackit】事前案内 {name} さん",
          body: "{name} さん\n\nご案内です。({email})",
          skipAlreadySent: true,
        }),
      },
      env,
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      source: string;
      recipientCount: number;
      emails: string[];
      sample: { to: string; subject: string; body: string } | null;
      participants: {
        participantTotal: number;
        withEmail: number;
        skipped: { name: string; reason: string }[];
      } | null;
    };

    expect(json.source).toBe("participants");
    // 対象イベントの提出者 4 名 (別イベント p5 は除外)
    expect(json.participants?.participantTotal).toBe(4);
    // KIT メール生成できたのは 2 名 (p1, p2)
    expect(json.emails).toEqual([
      "c1234567@st.kanazawa-it.ac.jp",
      "c7654321@st.kanazawa-it.ac.jp",
    ]);
    expect(json.recipientCount).toBe(2);
    // skipped: p3 (missing), p4 (invalid)
    expect(json.participants?.skipped.map((s) => s.reason)).toEqual([
      "missing_student_id",
      "invalid_student_id",
    ]);
    // 差し込みが効いている
    expect(json.sample?.to).toBe("c1234567@st.kanazawa-it.ac.jp");
    expect(json.sample?.subject).toBe("【Hackit】事前案内 田中太郎 さん");
    expect(json.sample?.body).toContain("田中太郎 さん");
    // ★preview は Gmail に一切触れない (実メール 0 通)
    expect(fetchCalls).toBe(0);
  });
});
