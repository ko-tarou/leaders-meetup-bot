/**
 * /admin 管理コンソール (Worker が返す静的 HTML+JS) のスモーク。
 *
 * admin-ui.ts のページ関数から HTML 文字列を取り出し、jsdom (runScripts) で
 * ページ内インライン JS を実際に実行し、fetch を stub して以下を固定する:
 *  - トークンが storage にある詳細ページはアクション一覧を描画する
 *  - トークンが無いとアクションを黙って空にせず「入力してください」ヒントを出す
 *  - token() は読むたびに storage へ永続化する (autofill で input 未発火でも
 *    一覧表示時にトークンを保存 → 詳細ページでアクションが出る回帰の要)
 *
 * これは PR #350 後に報告された「イベントは出るがアクションが出ない」不具合
 * (password manager の autofill で token が storage に載らず詳細ページで失効)
 * の回帰網。
 */
import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { adminEventDetailPage } from "../../src/routes/admin-ui";

const SPA_KEY = "devhub_ops:admin_token";
const TOKEN = "test-token";
const EVENT_ID = "cottage";

// c.html(str) 相当のフェイク Context で HTML 文字列を得る。
function detailHtml(): string {
  return adminEventDetailPage({ html: (s: string) => s } as never) as unknown as string;
}

const ACTIONS = [
  { id: "a1", eventId: EVENT_ID, actionType: "role_management", config: "{}", enabled: 1 },
  { id: "a2", eventId: EVENT_ID, actionType: "member_roster", config: "{}", enabled: 0 },
  // app_management: config.links がそのまま操作列のボタンになる (SPA 詳細リンクは出ない)。
  // 同一 origin (先頭 /) 以外の URL は描画しない。
  {
    id: "a3",
    eventId: EVENT_ID,
    actionType: "app_management",
    config: JSON.stringify({
      schemaVersion: 1,
      links: [
        { label: "表示コンテンツを編集", url: "/admin/cottage/content" },
        { label: "タイムテーブルを編集", url: "/admin/cottage" },
        { label: "外部", url: "https://evil.example.com" },
      ],
    }),
    enabled: 1,
  },
];
const EVENT = { id: EVENT_ID, type: "meetup", name: "コテージ", status: "active", config: "{}" };

// jsonFetch が期待する { ok, status, json() } を URL で出し分ける stub。
function stubFetch() {
  return (u: string) => {
    const url = String(u);
    let body: unknown = {};
    let ok = true;
    let status = 200;
    if (url.endsWith("/actions")) body = ACTIONS;
    else if (url.endsWith("/participation-forms")) body = [];
    else if (url.endsWith("/timetable")) { ok = false; status = 404; body = { error: "not found" }; }
    else if (url.match(/\/api\/orgs\/[^/]+$/)) body = EVENT;
    return Promise.resolve({ ok, status, json: () => Promise.resolve(body) });
  };
}

function loadDetail(presetToken: boolean): Promise<JSDOM> {
  const dom = new JSDOM(detailHtml(), {
    url: "http://localhost/admin/e/" + EVENT_ID,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(w) {
      (w as unknown as { fetch: unknown }).fetch = stubFetch();
      if (presetToken) w.localStorage.setItem(SPA_KEY, TOKEN);
    },
  });
  // インライン JS の async fetch chain が落ち着くのを待つ。
  return new Promise((r) => setTimeout(() => r(dom), 300));
}

describe("admin console detail page", () => {
  it("トークンが storage にあればアクション一覧を描画する", async () => {
    const dom = await loadDetail(true);
    const doc = dom.window.document;
    const rows = doc.querySelectorAll("#actions table tr");
    // header + 3 アクション行
    expect(rows.length).toBe(4);
    expect(doc.querySelector("#actions")!.textContent).toContain("ロール管理");
    expect(doc.querySelector("#actions")!.textContent).toContain("名簿");
    expect(doc.getElementById("m-name")!.getAttribute("value") ?? (doc.getElementById("m-name") as HTMLInputElement).value).toBe("コテージ");
    // 追加 select は登録済みを除外して候補を持つ。
    expect(doc.querySelectorAll("#add-type option").length).toBeGreaterThan(0);
    dom.window.close();
  });

  it("トークンが無ければ空にせずヒントを出す", async () => {
    const dom = await loadDetail(false);
    const doc = dom.window.document;
    expect(doc.querySelectorAll("#actions table tr").length).toBe(0);
    expect(doc.getElementById("actions")!.textContent).toContain("管理トークン");
    expect(doc.getElementById("status")!.textContent).toContain("管理トークン");
    dom.window.close();
  });

  it("token() は読むたびに storage へ永続化する (autofill 対策)", async () => {
    // storage 空 + autofill 相当: field に値を入れるが input を発火させない。
    const dom = new JSDOM(detailHtml(), {
      url: "http://localhost/admin/e/" + EVENT_ID,
      runScripts: "dangerously",
      pretendToBeVisual: true,
      beforeParse(w) { (w as unknown as { fetch: unknown }).fetch = stubFetch(); },
    });
    const w = dom.window;
    // 初期状態: storage 空
    expect(w.localStorage.getItem(SPA_KEY)).toBeNull();
    // autofill 相当で値をセット (input イベント無し)
    (w.document.getElementById("token") as HTMLInputElement).value = TOKEN;
    // 再読み込みを押す (reloadAll -> token() が呼ばれる)
    (w.document.getElementById("reload") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 300));
    // token() の読み取り時保存で storage に載っている
    expect(w.localStorage.getItem(SPA_KEY)).toBe(TOKEN);
    // アクションも描画される
    expect(w.document.querySelectorAll("#actions table tr").length).toBe(4);
    w.close();
  });

  it("app_management は config.links を操作列に描画する (同一 origin のみ)", async () => {
    const dom = await loadDetail(true);
    const doc = dom.window.document;
    const links = Array.from(doc.querySelectorAll("#actions table a")) as HTMLAnchorElement[];
    const labels = links.map((a) => a.textContent);
    expect(labels).toContain("表示コンテンツを編集");
    expect(labels).toContain("タイムテーブルを編集");
    // 外部 URL の link は描画されない
    expect(labels).not.toContain("外部");
    // app_management 行には SPA の「詳細/操作」リンクを出さない
    const contentLink = links.find((a) => a.textContent === "表示コンテンツを編集")!;
    expect(contentLink.getAttribute("href")).toBe("/admin/cottage/content");
    const row = contentLink.closest("tr")!;
    expect(row.textContent).toContain("アプリ管理");
    expect(row.textContent).not.toContain("詳細/操作");
    dom.window.close();
  });
});
