import type { Context } from "hono";
import type { Env } from "../types/env";

/**
 * 汎用イベント タイムテーブル 管理画面 (curl 不要の GUI)。
 *
 * - GET /admin            イベント一覧 → 新規作成 / 編集リンク / 削除。
 * - GET /admin/:eventId   1 イベントのメタ + タイムテーブル編集。
 *
 * 秘密情報を含まない静的 HTML を Worker から直接返す (React ビルド public/ は不変)。
 * 保存系は管理トークン (ADMIN_TOKEN) を入力し admin API を叩く。トークンは
 * sessionStorage に保持し一覧↔編集で共有する。
 */

const STYLE = `
  :root { font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif; }
  body { margin: 0; padding: 24px; background: #f8fafc; color: #0f172a; max-width: 1040px; }
  a { color: #1d4ed8; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .lede { color: #475569; font-size: 13px; margin: 0 0 16px; }
  .bar { position: sticky; top: 0; background: #f8fafc; padding: 12px 0; display: flex; gap: 8px; align-items: flex-end; flex-wrap: wrap; border-bottom: 1px solid #e2e8f0; z-index: 10; }
  button, .btn { padding: 6px 12px; border: 1px solid #cbd5e1; background: #fff; border-radius: 6px; cursor: pointer; font-size: 13px; text-decoration: none; color: #0f172a; display: inline-block; }
  button.add, .btn.add { border-color: #93c5fd; color: #1d4ed8; }
  button.del { border-color: #fca5a5; color: #b91c1c; }
  button.primary { background: #1d4ed8; color: #fff; border-color: #1d4ed8; }
  #status { font-size: 13px; font-weight: 600; }
  h2 { font-size: 15px; margin: 22px 0 8px; }
  .fld { display: flex; flex-direction: column; font-size: 11px; color: #64748b; gap: 2px; }
  .fld input, .fld textarea { padding: 5px 7px; border: 1px solid #cbd5e1; border-radius: 5px; font-size: 13px; color: #0f172a; font-family: inherit; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
  .tbl { border-collapse: collapse; width: 100%; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; }
  .tbl th, .tbl td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #eef2f7; font-size: 13px; }
  .tbl th { background: #f1f5f9; font-size: 11px; color: #475569; }
  .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; margin: 12px 0; }
  .day { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; margin-bottom: 14px; }
  .day-head { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; margin-bottom: 8px; }
  .item { display: grid; grid-template-columns: 70px 70px 1.6fr 1.2fr 1.2fr 90px auto; gap: 8px; align-items: end; padding: 8px 0; border-top: 1px dashed #e2e8f0; }
  .updated { color: #64748b; font-size: 12px; margin-top: 16px; }
  @media (max-width: 720px) { .item { grid-template-columns: 1fr 1fr; } }
`;

// 一覧・編集で共有する DOM ヘルパ + トークン管理。String.raw + DOM API で
// 外側テンプレートリテラルとの `${` 衝突を避ける。
const PRELUDE_JS = String.raw`
  var TOKEN_KEY = "tt_admin_token";
  var statusEl = document.getElementById("status");
  function setStatus(msg, ok) { statusEl.textContent = msg; statusEl.style.color = ok ? "#15803d" : "#b91c1c"; }
  function token() { return document.getElementById("token").value.trim(); }
  function initToken() {
    var t = document.getElementById("token");
    t.value = sessionStorage.getItem(TOKEN_KEY) || "";
    t.addEventListener("input", function () { sessionStorage.setItem(TOKEN_KEY, t.value.trim()); });
  }
  function authHeaders(json) {
    var h = { "x-admin-token": token() };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "class") n.className = attrs[k];
      else if (k === "value") n.value = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  function labeled(text, input) { return el("label", { class: "fld" }, [el("span", null, [text]), input]); }
  function input(value, oninput, placeholder) {
    var i = el("input", { value: value == null ? "" : String(value) });
    if (placeholder) i.placeholder = placeholder;
    if (oninput) i.addEventListener("input", function () { oninput(i.value); });
    return i;
  }
  function jsonFetch(url, opts) {
    return fetch(url, opts).then(function (r) { return r.json().then(function (b) { return { ok: r.ok, status: r.status, body: b }; }); });
  }
`;

// ---- 一覧ページ ----
const LIST_JS = String.raw`
(function () {
  initToken();
  var apiBase = location.origin + "/api/events";
  var listEl = document.getElementById("list");

  function td(v) { return el("td", null, [String(v == null ? "" : v)]); }
  function th(v) { return el("th", null, [v]); }

  function render(events) {
    listEl.textContent = "";
    if (!events.length) { listEl.appendChild(el("p", { class: "lede" }, ["イベントがありません。下のフォームから作成してください。"])); return; }
    var table = el("table", { class: "tbl" }, []);
    table.appendChild(el("tr", null, [th("名前"), th("id"), th("期間"), th("日/項目"), th("更新"), th("操作")]));
    events.forEach(function (ev) {
      var editA = el("a", { href: "/admin/" + ev.id, class: "btn add" }, ["編集"]);
      var del = el("button", { class: "del" }, ["削除"]);
      del.addEventListener("click", function () { removeEvent(ev.id, ev.name); });
      table.appendChild(el("tr", null, [
        td(ev.name), td(ev.id), td((ev.startDate || "?") + " 〜 " + (ev.endDate || "?")),
        td(ev.dayCount + "日 / " + ev.itemCount + "項目"), td(ev.updatedAt || ""),
        el("td", null, [editA, document.createTextNode(" "), del])
      ]));
    });
    listEl.appendChild(table);
  }

  function loadList() {
    if (!token()) { setStatus("管理トークンを入力してください", false); return; }
    setStatus("読み込み中...", true);
    jsonFetch(apiBase, { headers: authHeaders(false) })
      .then(function (res) {
        if (!res.ok) { setStatus("一覧取得失敗 (" + res.status + "): " + (res.body.error || "トークンを確認"), false); return; }
        render(res.body.events);
        setStatus("読み込み完了 (" + res.body.events.length + "件)", true);
      })
      .catch(function (e) { setStatus("取得失敗: " + e, false); });
  }

  function removeEvent(id, name) {
    if (!confirm("イベント「" + name + "」を削除しますか？")) return;
    jsonFetch(apiBase + "/" + id, { method: "DELETE", headers: authHeaders(false) })
      .then(function (res) {
        if (!res.ok) { setStatus("削除失敗 (" + res.status + "): " + (res.body.error || ""), false); return; }
        setStatus("削除しました", true); loadList();
      })
      .catch(function (e) { setStatus("削除失敗: " + e, false); });
  }

  function createEvent() {
    var body = {
      id: document.getElementById("new-id").value.trim(),
      name: document.getElementById("new-name").value.trim(),
      startDate: document.getElementById("new-start").value.trim(),
      endDate: document.getElementById("new-end").value.trim(),
      description: document.getElementById("new-desc").value.trim()
    };
    if (!token()) { setStatus("管理トークンを入力してください", false); return; }
    if (!body.name) { setStatus("イベント名を入力してください", false); return; }
    jsonFetch(apiBase, { method: "POST", headers: authHeaders(true), body: JSON.stringify(body) })
      .then(function (res) {
        if (!res.ok) { setStatus("作成失敗 (" + res.status + "): " + (res.body.error || ""), false); return; }
        location.href = "/admin/" + res.body.id;
      })
      .catch(function (e) { setStatus("作成失敗: " + e, false); });
  }

  document.getElementById("reload").addEventListener("click", loadList);
  document.getElementById("create").addEventListener("click", createEvent);
  loadList();
})();
`;

// ---- 編集ページ ----
const EDITOR_JS = String.raw`
(function () {
  initToken();
  var id = decodeURIComponent(location.pathname.replace(/^\/admin\//, ""));
  document.getElementById("evid").textContent = id;
  var apiBase = location.origin + "/api/events";
  var meta = { name: "", startDate: "", endDate: "", description: "" };
  var days = [];
  var updatedEl = document.getElementById("updated");

  function bindMeta() {
    document.getElementById("m-name").value = meta.name;
    document.getElementById("m-start").value = meta.startDate;
    document.getElementById("m-end").value = meta.endDate;
    document.getElementById("m-desc").value = meta.description;
  }

  function renderDays() {
    var root = document.getElementById("days");
    root.textContent = "";
    days.forEach(function (day, di) {
      var head = el("div", { class: "day-head" }, [
        labeled("Day", input(String(day.day), function (v) { day.day = parseInt(v, 10) || 0; }, "1")),
        labeled("日付", input(day.date, function (v) { day.date = v; }, "YYYY-MM-DD")),
        el("button", { class: "del" }, ["この日を削除"])
      ]);
      head.querySelector(".del").addEventListener("click", function () { days.splice(di, 1); renderDays(); });

      var itemsWrap = el("div", { class: "items" }, []);
      (day.items || []).forEach(function (it, ii) {
        var row = el("div", { class: "item" }, [
          labeled("開始", input(it.start, function (v) { it.start = v; }, "HH:mm")),
          labeled("終了", input(it.end, function (v) { it.end = v; }, "HH:mm")),
          labeled("内容", input(it.title, function (v) { it.title = v; }, "タイトル")),
          labeled("場所", input(it.location, function (v) { it.location = v; }, "")),
          labeled("メモ", input(it.note, function (v) { it.note = v; }, "")),
          labeled("id", input(it.id, function (v) { it.id = v; }, "")),
          el("button", { class: "del" }, ["削除"])
        ]);
        row.querySelector(".del").addEventListener("click", function () { day.items.splice(ii, 1); renderDays(); });
        itemsWrap.appendChild(row);
      });

      var addItem = el("button", { class: "add" }, ["＋ 項目を追加"]);
      addItem.addEventListener("click", function () {
        if (!day.items) day.items = [];
        var n = day.items.length + 1;
        day.items.push({ id: "d" + day.day + "-" + n, start: "", end: "", title: "", location: "", note: "" });
        renderDays();
      });
      root.appendChild(el("section", { class: "day" }, [head, itemsWrap, addItem]));
    });
  }

  function collect() {
    return {
      name: document.getElementById("m-name").value.trim(),
      startDate: document.getElementById("m-start").value.trim(),
      endDate: document.getElementById("m-end").value.trim(),
      description: document.getElementById("m-desc").value,
      days: days
    };
  }

  function load() {
    setStatus("読み込み中...", true);
    jsonFetch(apiBase + "/" + id + "/timetable", { headers: { "Accept": "application/json" } })
      .then(function (res) {
        if (!res.ok) { setStatus("読み込み失敗 (" + res.status + "): " + (res.body.error || ""), false); return; }
        meta = { name: res.body.name, startDate: res.body.startDate, endDate: res.body.endDate, description: res.body.description };
        days = res.body.days || [];
        updatedEl.textContent = "現在の updatedAt: " + (res.body.updatedAt || "(なし)");
        bindMeta(); renderDays();
        setStatus("読み込み完了", true);
      })
      .catch(function (e) { setStatus("読み込み失敗: " + e, false); });
  }

  function save() {
    if (!token()) { setStatus("管理トークンを入力してください", false); return; }
    var body = collect();
    if (!body.name) { setStatus("イベント名は必須です", false); return; }
    setStatus("保存中...", true);
    jsonFetch(apiBase + "/" + id, { method: "PUT", headers: authHeaders(true), body: JSON.stringify(body) })
      .then(function (res) {
        if (!res.ok) { setStatus("保存失敗 (" + res.status + "): " + (res.body.error || ""), false); return; }
        updatedEl.textContent = "現在の updatedAt: " + res.body.updatedAt;
        setStatus("保存しました。配信に反映されます。", true);
      })
      .catch(function (e) { setStatus("保存失敗: " + e, false); });
  }

  function removeEvent() {
    if (!token()) { setStatus("管理トークンを入力してください", false); return; }
    if (!confirm("このイベント (" + id + ") を削除しますか？")) return;
    jsonFetch(apiBase + "/" + id, { method: "DELETE", headers: authHeaders(false) })
      .then(function (res) {
        if (!res.ok) { setStatus("削除失敗 (" + res.status + "): " + (res.body.error || ""), false); return; }
        location.href = "/admin";
      })
      .catch(function (e) { setStatus("削除失敗: " + e, false); });
  }

  document.getElementById("reload").addEventListener("click", load);
  document.getElementById("save").addEventListener("click", save);
  document.getElementById("delete").addEventListener("click", removeEvent);
  document.getElementById("add-day").addEventListener("click", function () {
    days.push({ day: days.length + 1, date: "", items: [] });
    renderDays();
  });
  load();
})();
`;

const LIST_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>イベント管理</title><style>${STYLE}</style></head>
<body>
<h1>イベント タイムテーブル管理</h1>
<p class="lede">iOS などへ配信するイベントのタイムテーブルを作成・編集・削除します。保存には管理トークンが必要です。</p>
<div class="bar">
  <label class="fld"><span>管理トークン</span><input id="token" type="password" placeholder="ADMIN_TOKEN" /></label>
  <button id="reload">再読み込み</button>
  <span id="status"></span>
</div>
<h2>イベント一覧</h2>
<div id="list"></div>
<h2>新規イベント作成</h2>
<div class="card">
  <div class="row">
    <label class="fld"><span>id (任意・空なら名前から生成)</span><input id="new-id" placeholder="例: summer-camp" /></label>
    <label class="fld"><span>イベント名</span><input id="new-name" placeholder="例: 夏合宿" /></label>
    <label class="fld"><span>開始日</span><input id="new-start" placeholder="YYYY-MM-DD" /></label>
    <label class="fld"><span>終了日</span><input id="new-end" placeholder="YYYY-MM-DD" /></label>
    <label class="fld"><span>説明</span><input id="new-desc" placeholder="任意" /></label>
    <button id="create" class="primary">作成して編集へ</button>
  </div>
</div>
<script>${PRELUDE_JS}${LIST_JS}</script>
</body></html>`;

const EDITOR_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>イベント編集</title><style>${STYLE}</style></head>
<body>
<p class="lede"><a href="/admin">← イベント一覧へ</a></p>
<h1>イベント編集: <span id="evid"></span></h1>
<p class="lede">メタ情報とタイムテーブルを編集します。保存には管理トークンが必要です。</p>
<div class="bar">
  <label class="fld"><span>管理トークン</span><input id="token" type="password" placeholder="ADMIN_TOKEN" /></label>
  <button id="reload">再読み込み</button>
  <button id="save" class="primary">保存</button>
  <button id="delete" class="del">イベント削除</button>
  <span id="status"></span>
</div>
<h2>イベント情報</h2>
<div class="row">
  <label class="fld"><span>名前</span><input id="m-name" /></label>
  <label class="fld"><span>開始日</span><input id="m-start" placeholder="YYYY-MM-DD" /></label>
  <label class="fld"><span>終了日</span><input id="m-end" placeholder="YYYY-MM-DD" /></label>
  <label class="fld"><span>説明</span><input id="m-desc" /></label>
</div>
<h2>日程</h2>
<div id="days"></div>
<button id="add-day" class="add">＋ 日を追加</button>
<p class="updated" id="updated"></p>
<script>${PRELUDE_JS}${EDITOR_JS}</script>
</body></html>`;

export function adminListPage(c: Context<{ Bindings: Env }>) {
  return c.html(LIST_HTML);
}

export function adminEventPage(c: Context<{ Bindings: Env }>) {
  return c.html(EDITOR_HTML);
}
